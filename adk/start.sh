#!/bin/bash

# Simple startup script for the GSR ADK Local Prototype

echo "🚀 Starting GSR ADK Local Prototype..."

if [ -z "$GEMINI_API_KEY" ] && [ ! -f "backend/.env" ]; then
  echo "⚠️  WARNING: GEMINI_API_KEY environment variable is not set."
  echo "The backend API will fail when attempting to call Vertex/Gemini models."
  echo "Please run: export GEMINI_API_KEY=\"your-key\" or create backend/.env"
  echo "Continuing anyway, but you will likely see 500 errors on the frontend..."
  echo ""
fi

# Function to cleanup background processes on exit
cleanup() {
    echo ""
    echo "🛑 Shutting down ADK services..."
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    echo "✅ Shutdown complete."
    exit
}

# Trap SIGINT (Ctrl+C) and SIGTERM to run the cleanup function
trap cleanup SIGINT SIGTERM

echo "📦 Ensuring backend dependencies are installed..."
cd backend && npm install > /dev/null 2>&1
cd ..

echo "📦 Ensuring frontend dependencies are installed..."
cd frontend && npm install > /dev/null 2>&1
cd ..

echo "🟢 Starting Backend API (Port 8080)..."
cd backend
npm run dev &
BACKEND_PID=$!
cd ..

# Give the backend a second to initialize
sleep 2

echo "🟢 Starting Frontend UI (Port 3000)..."
cd frontend
npm start &
FRONTEND_PID=$!
cd ..

echo "======================================================="
echo "✅ ADK is successfully running!"
echo "👉 Open your browser to: http://localhost:3000"
echo "🖥️  To stop both servers, press Ctrl+C in this terminal"
echo "======================================================="

# Wait indefinitely for processes to finish (or Ctrl+C to stop)
wait $BACKEND_PID $FRONTEND_PID
