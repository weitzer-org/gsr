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

echo "=================================================="
echo " GSR — local dev"
echo " App:           http://localhost:8080"
echo " MinIO console: http://localhost:9001 (minioadmin/minioadmin)"
echo "=================================================="

exec docker compose up --build "$@"
