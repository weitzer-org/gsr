# GSR (Gemini Subagent Reviewer) — Project Guide

Multi-agent AI code review tool: a swarm of specialized Gemini subagents
(Architecture, Logic, Security, TechDebt, Testing, ...) reviews a GitHub PR
diff in parallel, then a Deduplicator agent merges overlapping findings. An
evaluation harness (`tools/eval`) benchmarks prompt/agent changes against
production and ablation baselines.

## Run locally (Docker)
Local dev runs the backend in a container with a **MinIO** (S3-compatible)
store standing in for Cloudflare R2 — no cloud accounts required.

```bash
cp .env.example .env   # first time; set a real GEMINI_API_KEY
./run.sh                # builds + starts app + MinIO via docker compose
```
- App: http://localhost:8080
- MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`)
- Stop: `docker compose down` (add `-v` to also wipe the MinIO volume)

Without Docker: `cd adk/backend && npm install && npm run dev` (reads
`adk/backend/.env`), and `cd adk/frontend && npm install && npm start`
separately.

## Architecture
- `adk/backend` — Express API (`src/app.ts`). Fetches the PR diff via
  `github.ts`, fans it out through `orchestrator.ts` to the subagents
  (`agent.ts`, prompts in `adk/prompts/`), then `deduplicator.ts` merges
  findings. Talks to Gemini via `@google/genai` using a plain API key — no
  GCP project required.
- `adk/frontend` — static Express server serving the vanilla-JS review UI.
- `adk/backend/src/storage.ts` — thin S3-compatible wrapper (`@aws-sdk/
  client-s3`) used for review-history and eval-result persistence. Works
  against MinIO locally or Cloudflare R2 in prod; add capabilities here,
  don't reach for the AWS SDK directly in callers.
- `tools/eval` — standalone evaluation harness (`evaluate.ts`, deployed as
  its own Fly app, `tools/eval/storage.ts` mirrors the backend's wrapper)
  that runs the same PR through two targets (local/production/a branch) and
  has an independent Gemini pass judge the diff in findings quality.

## Storage & secrets
Object storage is S3-compatible everywhere: `S3_BUCKET`, `S3_REVIEW_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` (unset = local
MinIO), `S3_REGION` (`auto` for R2). See `.env.example` /
`adk/backend/.env.example` / `tools/eval/.env.example`.

Secrets are plain env vars — `.env` locally (git-ignored, never commit it),
`fly secrets set` in production. There is no GCP Secret Manager / Vertex ADC
path anymore (removed in the Fly.io migration); don't reintroduce
`GOOGLE_APPLICATION_CREDENTIALS`-style auto-loading.

## Tests
- `cd adk/backend && npm test` — Jest + Supertest (mocks `storage.ts` and
  the Gemini SDK; never hits real object storage or the network).
- `cd adk/frontend && npm test` — Jest; `npm run test:e2e` for Playwright.
- `cd tools/eval && npm test` — Jest + ts-jest.
- Node isn't on PATH by default in every shell here — if `node`/`npm` are
  missing, install via `nvm` (`~/.nvm`) and symlink into `~/.local/bin`
  rather than reinstalling from scratch each time.

## Code review
`.github/workflows/deploy.yml` runs all three test suites on every push/PR
and gates the Fly.io deploy on them passing — but tests don't catch design,
security, or simplification issues, so review before merging is still the
main quality gate.

- Before opening/merging a PR, run **`/code-review low`** or
  **`/code-review medium`** against the branch diff — always pass the effort
  level explicitly. Bare `/code-review` (no args) defaults to `high`, which
  spawns 8 parallel finder agents plus verification passes; that's the
  expensive tier, not the routine one.
- Small/low-risk diffs (docs, config, prompt wording): `/code-review low` is
  enough.
- Larger or risky changes (agent orchestration, storage/secrets, auth):
  `/code-review high`.
- Reserve `/code-review ultra` (multi-agent cloud review) for substantial
  features before merge — it's billed separately, so don't run it routinely.
- `/code-review --fix` applies the findings directly if you want them
  auto-fixed instead of just reported.

## Deployment
- **Fly.io** (current runtime): `fly.toml` (main backend, app
  `gsr-code-review`) and `fly.eval.toml` (evaluator, app `gsr-evaluator`);
  secrets via `fly secrets set --config <file>`; storage = Cloudflare R2.
  Both scale to zero when idle.
- **GCP** (retired, preserved): `cloudbuild.gcp.yaml` /
  `cloudbuild-eval.gcp.yaml` → Cloud Run + GCS + Secret Manager. The live
  `cloudbuild.yaml`/`cloudbuild-eval.yaml` are intentionally disabled stubs.
- Deploy from the repo root (both Dockerfiles COPY across `adk/` and
  `tools/eval/`, so the build context must be root, not the subdirectory).

## Conventions
- Storage is accessed only through `storage.ts`'s exported functions in each
  package; add capabilities there, don't instantiate `S3Client` in callers.
- Don't reintroduce Vertex AI / ADC / `GOOGLE_APPLICATION_CREDENTIALS` —
  Gemini access is API-key-only now (`GEMINI_API_KEY`).
- `local_vs_branch` / `branch_vs_production` eval comparisons require a
  manually deployed staging URL (`STAGING_URL` env var) — the old
  Cloud-Build auto-deploy-a-branch flow has no Fly equivalent and was
  removed, not replaced.
