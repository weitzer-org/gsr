# Evaluation Harness Setup Instructions

To successfully run the evaluation harness locally, you need to properly configure your Google Cloud Platform (GCP) credentials, Secret Manager, and environment variables.

## 1. Google Cloud Authentication

The core harness uses the official `@google-cloud/secret-manager` and `@google-cloud/storage` SDKs, which rely on **Application Default Credentials (ADC)**.

First, ensure you have the `gcloud` CLI installed, then run the following commands in your terminal:

```bash
# Log in to your Google Account
gcloud auth login

# Set your active project (replace 'weitzer-org' with your actual Project ID if different)
gcloud config set project weitzer-org

# Generate the Application Default Credentials file for Node.js
gcloud auth application-default login
```

*(Note: If you are running on Jetski, you can also manually point to your existing Service Account key by exporting it: `export GOOGLE_APPLICATION_CREDENTIALS=/Users/benweitzer/projects/GSR/jetski-sa-key.json`)*

## 2. Setting Up Secret Manager

The harness securely fetches your GitHub Personal Access Token (PAT) from Secret Manager before scanning PRs. We need to create this secret.

You can create it directly via the `gcloud` CLI:

```bash
# Create the secret container
gcloud secrets create gsr-github-pat --replication-policy="automatic"

# Add your actual GitHub PAT as the first version
# Important: ensure there is no trailing newline in your PAT by using `-n`
echo -n "YOUR_GITHUB_PAT_HERE" | gcloud secrets versions add gsr-github-pat --data-file=-
```

## 3. Environment Variables

The harness requires a few environment variables to operate. You can either `export` them in your terminal session or create a `.env` file inside `tools/eval/`.

**Required:**
- `GEMINI_API_KEY`: Your Gemini API Key for the LLM Comparator step.

**Optional (Defaults are provided):**
- `LOCAL_URL`: The URL of your local ADK backend (default: `http://localhost:8080`)
- `PRODUCTION_URL`: The URL of your production Cloud Run instance.
- `GOOGLE_CLOUD_PROJECT`: Your GCP project ID (default: `weitzer-org`).
- `GCS_BUCKET`: The bucket name to store evaluation results (default: `gsr-eval-results-weitzer-org`).
- `GCS_REVIEW_BUCKET`: The bucket name for review results used by the backend (default: `gsr-review-results-weitzer-org`).
- `GITHUB_PAT_SECRET`: The name of the secret in Secret Manager (default: `gsr-github-pat`).

Example `.env` file:
```env
GEMINI_API_KEY="AIzaSyYourKeyHere..."
LOCAL_URL="http://localhost:8080"
PRODUCTION_URL="https://your-cloud-run-url.run.app"
```

## 4. Running the Evaluation

Once authenticated and configured, you are ready to run the tests! 

Update `tools/eval/config.json` with the Pull Request URLs you want to evaluate, and run:

```bash
cd tools/eval
npm run eval
```

> **Bucket Creation:** You do not need to manually create the Google Cloud Storage bucket! The `gcs-storage.ts` module will automatically create it on your first run if it doesn't already exist.
