#!/usr/bin/env bash
# Run the full GSR stack (backend + MinIO) locally via Docker.
# A valid GEMINI_API_KEY must be set in .env (get one from Google AI Studio —
# no GCP project needed).
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || cp .env.example .env

# Guard: refuse to start without a real key. Read the effective (last)
# GEMINI_API_KEY line and tolerate surrounding whitespace.
KEY=$(grep -E '^[[:space:]]*GEMINI_API_KEY[[:space:]]*=' .env | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*$//')
if [ -z "$KEY" ] || printf '%s' "$KEY" | grep -q 'replace-with'; then
  echo "ERROR: set a real GEMINI_API_KEY in .env before running." >&2
  echo "       (Get one from Google AI Studio — no GCP project needed.)" >&2
  exit 1
fi

APP_URL="http://localhost:8090"
MINIO_URL="http://localhost:9011"

echo "=================================================="
echo " GSR — local dev (building...)"
echo " App:           $APP_URL"
echo " MinIO console: $MINIO_URL (minioadmin/minioadmin)"
echo "=================================================="

docker compose up -d --build "$@"

# Wait for the app to actually be reachable so the URL below isn't buried
# under build/startup logs.
echo -n "Waiting for the app to come up..."
for i in $(seq 1 60); do
  if curl -sf "$APP_URL/api/status" >/dev/null 2>&1; then
    echo " ready!"
    break
  fi
  echo -n "."
  sleep 1
done

echo "=================================================="
echo " GSR is running:"
echo "   App:           $APP_URL"
echo "   MinIO console: $MINIO_URL (minioadmin/minioadmin)"
echo " Logs:  docker compose logs -f"
echo " Stop:  docker compose down"
echo "=================================================="

exec docker compose logs -f
