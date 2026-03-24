#!/bin/bash
set -euo pipefail

# Startup script for the GSR ADK using Google Cloud Secret Manager

echo "🚀 Starting GSR ADK with Google Cloud Secret Manager..."

# Load config from .env if it exists
if [ -f backend/.env ]; then
    SECRET_CONFIG=$(grep '^SECRET_MANAGER_SECRET_NAME=' backend/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'" || true)
fi

SECRET_NAME=${SECRET_CONFIG:-${1:-"gsr-gemini-api-key"}}

# Extract just the secret name if a full resource path was provided in the config
SECRET_NAME=$(basename "$SECRET_NAME")

echo "Fetching secret '$SECRET_NAME' from Google Cloud Secret Manager..."

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "⚠️ gcloud is not installed. Attempting automatic installation..."
    if command -v brew &> /dev/null; then
        echo "📦 Installing Google Cloud SDK via Homebrew..."
        brew install --cask google-cloud-sdk
    else
        echo "📦 Installing Google Cloud SDK via official script..."
        # Security Note: Piping curl to bash executes remote code without verification.
        # This is a known risk, but is the official installation method provided by Google.
        curl https://sdk.cloud.google.com | bash -s -- --disable-prompts
        # Load it into current PATH for this script execution
        if [ -f "$HOME/google-cloud-sdk/path.bash.inc" ]; then
            source "$HOME/google-cloud-sdk/path.bash.inc"
        elif [ -f "$HOME/google-cloud-sdk/path.zsh.inc" ]; then
            source "$HOME/google-cloud-sdk/path.zsh.inc"
        fi
    fi
    
    # Verify installation again
    if ! command -v gcloud &> /dev/null; then
        echo "❌ Automatic installation failed or gcloud is not in PATH."
        echo "Please install the Google Cloud SDK manually."
        exit 1
    fi
    echo "✅ gcloud successfully installed."
fi

# Check if authenticated
echo "Checking Google Cloud authentication..."
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status=ACTIVE --format="value(account)" 2>/dev/null || true)
if [ -z "$ACTIVE_ACCOUNT" ]; then
    echo "❌ Error: No active Google Cloud account found."
    echo ""
    echo "Please authenticate by running:"
    echo "  gcloud auth login"
    echo ""
    echo "If you are on a remote/managed machine (like Jetski) and encounter Context Aware Access errors:"
    echo "  1. Run this command on your Jetski instance:"
    echo "     gcloud auth login --no-browser"
    echo "  2. It will output a long command starting with 'gcloud auth login --remote-bootstrap=...'"
    echo "  3. Copy that ENTIRE command (not just the URL) and run it in a terminal on your PHYSICAL laptop."
    echo "  4. Follow the steps on your physical laptop, then paste the resulting code back into the Jetski terminal."
    echo ""
    exit 1
fi

# Get active project
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ]; then
  echo "❌ Error: No active Google Cloud project configured."
  echo "Please run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

echo "Using GCP Project: $PROJECT_ID"

if SECRET_VALUE=$(gcloud secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null); then
  echo "✅ Successfully fetched GEMINI_API_KEY from Secret Manager."
  export GEMINI_API_KEY="$SECRET_VALUE"
else
  echo "❌ Failed to fetch secret '$SECRET_NAME'."
  echo "Please ensure:"
  echo "  1. You are authenticated: gcloud auth login"
  echo "  2. The secret exists in project '$PROJECT_ID'"
  echo "  3. You have the Secret Manager Secret Accessor role."
  echo ""
  exit 1
fi

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down ADK services..."
    kill ${BACKEND_PID:-} 2>/dev/null || true
    kill ${FRONTEND_PID:-} 2>/dev/null || true
    echo "✅ Shutdown complete."
    exit
}

# Trap SIGINT (Ctrl+C) and SIGTERM to run the cleanup function
trap cleanup SIGINT SIGTERM

echo "📦 Ensuring backend dependencies are installed..."
if [ ! -d "backend/node_modules" ]; then
  (cd backend && npm install)
else
  echo "✅ Backend dependencies already installed."
fi

echo "📦 Ensuring frontend dependencies are installed..."
if [ ! -d "frontend/node_modules" ]; then
  (cd frontend && npm install)
else
  echo "✅ Frontend dependencies already installed."
fi

echo "🟢 Starting Unified ADK Server (Port 8080)..."
cd backend
npx tsc
npm start &
BACKEND_PID=$!
cd ..

# Give the backend a second to initialize
sleep 2

echo "======================================================="
echo "✅ ADK is successfully running!"
echo "👉 Open your browser to: http://localhost:8080"
echo "🖥️  To stop the server, press Ctrl+C in this terminal"
echo "======================================================="

# Wait indefinitely for process to finish
wait $BACKEND_PID
