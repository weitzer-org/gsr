# Evaluation Harness Setup Instructions

To run the evaluation harness locally, configure your GitHub token, Gemini API key, and object storage credentials as environment variables.

## 1. Credentials

Create a `.env` file inside `tools/eval/` (see `.env.example`) with:

```env
GITHUB_TOKEN="ghp_yourPatHere"
GEMINI_API_KEY="AIzaSyYourKeyHere..."   # Google AI Studio key — no GCP project required
```

## 2. Object Storage

The harness archives each run to an S3-compatible bucket — Cloudflare R2 in production, or a local MinIO container for dev (see the root `docker-compose.yml`).

```env
S3_BUCKET="gsr-eval-results"
S3_ACCESS_KEY_ID="minioadmin"
S3_SECRET_ACCESS_KEY="minioadmin"
S3_REGION="auto"
# S3_ENDPOINT="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"  # unset for local MinIO
```

## 3. Environment Variables

**Required:**
- `GEMINI_API_KEY`: Your Gemini API Key for the LLM Comparator step.
- `GITHUB_TOKEN` (or `GITHUB_PAT`): A GitHub PAT with `repo` read access.

**Optional (Defaults are provided):**
- `LOCAL_URL`: The URL of your local ADK backend (default: `http://localhost:8080`)
- `PRODUCTION_URL`: The URL of your production Fly.io instance.
- `S3_BUCKET`: The bucket name to store evaluation results (default: `gsr-eval-results`).
- `S3_REVIEW_BUCKET`: The bucket name for review results used by the backend (default: `gsr-review-results`).
- `STAGING_URL`: For `local_vs_branch`/`branch_vs_production` comparisons, the URL of a manually-deployed staging branch (deploy it yourself, e.g. `fly deploy -a gsr-code-review-staging`).

## 4. Running the Evaluation

Once configured, you are ready to run the tests!

Update `tools/eval/config.json` with the Pull Request URLs you want to evaluate, and run:

```bash
cd tools/eval
npm run eval
```

> **Bucket Creation:** You do not need to manually create the bucket! The `storage.ts` module will automatically create it on your first run if it doesn't already exist.
