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
- App: http://localhost:8090 (host port shifted from the default 8080 so it
  doesn't collide with the sound-profile-builder project's local stack)
- MinIO console: http://localhost:9011 (`minioadmin` / `minioadmin`)
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
`S3_FEEDBACK_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_ENDPOINT` (unset = local MinIO), `S3_REGION` (`auto` for R2). See
`.env.example` / `adk/backend/.env.example` / `tools/eval/.env.example`.
Unlike the other two buckets, `S3_FEEDBACK_BUCKET` has no auto-create logic
even locally-adjacent to prod — its MinIO bucket is created by
`docker-compose.yml`'s `createbuckets` one-shot the same way the other two
are, but the real R2 bucket (`gsr-review-feedback`) must be created manually
in the Cloudflare dashboard before setting the Fly secret, exactly like
`gsr-review-results` was (`adk/backend/src/storage.ts` never auto-creates
buckets in prod — see `finding-feedback-requirements.md` §7).

Secrets are plain env vars — `.env` locally (git-ignored, never commit it),
`fly secrets set` in production. There is no GCP Secret Manager / Vertex ADC
path anymore (removed in the Fly.io migration); don't reintroduce
`GOOGLE_APPLICATION_CREDENTIALS`-style auto-loading.

**Usage analytics.** Every real Gemini call in `adk/backend` (agent.ts,
deduplicator.ts, evaluator.ts, adjudicator.ts, plus the `test_deduplicator.ts`/
`debug-single.ts` dev scripts) is wrapped by `trackGeminiCall`
(`adk/backend/src/usage.ts`), which persists a per-call token/latency/cost/
success record to `S3_REVIEW_BUCKET` under `usage/<date>/`. `tools/eval`'s
own judge calls (`llm-comparator.ts`/`llm-comparator-v2.ts`) are tracked the
same way by a separate, parallel `tools/eval/usage.ts`, into that service's
own bucket (`S3_BUCKET`, default `gsr-eval-results`) — `GET /api/usage/
summary` and the `/usage.html` dashboard read both. The sibling
`job_tracker` and `sound-profile-builder` projects also push their own
native (non-review) Gemini usage into this same dashboard via `POST
/api/usage/ingest`, classified under a third `"product"` workload bucket
alongside GSR's own `"review"`/`"eval"` split — see
`usage_analytics_reference.md` for the schema and query recipes (the
`usage-report.js` CLI, the dashboard API, or raw `jq`-over-S3) — read that
before answering any "what's our token spend/error rate" question instead of
re-deriving the storage layout. `PRICE_TABLE` now has **three** copies to
keep in sync when Gemini prices change: `adk/backend/src/usage.ts`,
`tools/eval/usage.ts`, and the sibling `job_tracker` project's
`internal/scoring/pricing.go`.

## Auth
Both Fly apps were originally deployed with zero auth on their public URLs
— `fly.toml`'s `app = 'gsr-code-review'` is public in this repo, so the
default `https://gsr-code-review.fly.dev` URL is directly discoverable, not
just guessable. Independent gates now cover this:
- `adk/backend` (browser UI + API): password login, mirroring the
  sound-profile-builder pattern — `UI_PASSWORD` env var, stateless signed
  cookie session (`adk/backend/src/auth.ts`, no server-side session store).
  `requireAuth` gates everything except `/api/status`, `GET/POST /login`,
  and `POST /logout`. Signing key is `SESSION_SECRET` if set, else falls
  back to `UI_PASSWORD` — set `SESSION_SECRET` to decouple the two, so a
  captured session token can't be used to brute-force the login password.
- `tools/eval` (server-to-server only, no browser UI of its own): shared
  secret checked via `X-Internal-Key` header on `/api/evaluate`
  (`tools/eval/internalAuth.ts`), value = `EVALUATOR_SHARED_SECRET`. The
  main backend attaches this header when it triggers a remote eval run
  (`/api/evals/start` → `EVALUATOR_SERVICE_URL/api/evaluate`); both apps'
  Fly secrets must hold the same value.
- `POST /api/usage/ingest` (`adk/backend/src/usageIngestAuth.ts`): shared
  secret via `X-Usage-Ingest-Key`, value = `USAGE_INGEST_SHARED_SECRET`. Two
  independent callers use it: a consumer repo's GitHub Action reporting
  review usage, and `tools/eval/usage.ts` reporting its own judge-call usage
  from *any* environment it runs in — a developer's laptop included, via
  `adk/backend/src/usageReporter.ts`'s `reportUsage()` (shared by both
  callers, not duplicated). This is why local `tools/eval` runs show up on
  the production usage dashboard without ever holding real R2 write
  credentials — see `usage_analytics_reference.md`.
- `POST/GET /api/findings/feedback` (`adk/backend/src/feedbackAuth.ts`, the
  finding-feedback push endpoint — `finding-feedback-requirements.md`):
  `POST` accepts **either** a `X-Feedback-Key` header matching
  `FEEDBACK_SHARED_SECRET` **or** a valid `UI_PASSWORD` session cookie, so
  headless consumers (an AI coding agent, this repo's own PR-comment
  feedback loop reporting from a GitHub Action) and the browser share one
  endpoint without two implementations; `GET` sits behind the existing
  session gate only (no shared secret needed to read). Registered before
  `requireAuth`, same placement pattern as `/api/usage/ingest`.
- **`UI_PASSWORD` and `FEEDBACK_SHARED_SECRET` are required in production**;
  **`EVALUATOR_SHARED_SECRET` is the one exception**, no-op when unset
  (local dev / test convenience, same convention as this repo's other
  optional secrets) even in production. Each app's entrypoint
  (`adk/backend/src/index.ts`, `tools/eval/server.ts`) calls a startup guard
  at boot (`assertProductionAuthConfigured` / `assertProductionUsageIngestConfigured`
  / `assertProductionFeedbackAuthConfigured` / `assertProductionSecretConfigured`)
  — `NODE_ENV=production`, set by both Dockerfiles — so a missing required
  secret fails loudly (deploy/health-check failure) instead of silently
  re-opening the app. `adk/backend` only *warns* if `EVALUATOR_SHARED_SECRET`
  is missing, since that's a supplementary outbound-call feature, not a
  primary protection the way the other three are — `FEEDBACK_SHARED_SECRET`
  is required despite the cookie fallback, since that fallback only covers
  the browser path, not the headless-agent path the endpoint primarily
  exists for.

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

**Cost policy (Claude quota is a real constraint on this project).** The
bundled `/code-review` spawns 8 finder agents plus up to 8 verifiers at
`high` — the single largest discretionary expense in the workflow. So it is
**not** the default. The default pre-merge review is the project's own
**`/quick-review`** (`.claude/skills/quick-review/`): one inline pass, no
sub-agents, ~1 call. CodeRabbit and gemini-code-assist both review every PR
automatically at zero Claude quota and are the automated second opinion that
makes a cheaper local pass acceptable, on top of the CI test gate above.

- **Default — every PR:** run **`/quick-review`** against the branch diff,
  then let CodeRabbit and gemini-code-assist backstop it on the open PR.
- **Escalate to the multi-agent `/code-review medium`/`high`** only for large
  or architecturally risky changes (agent orchestration, storage/secrets,
  auth) where the fan-out's extra recall is worth the extra calls. Always
  pass the effort level explicitly.
- Reserve `/code-review ultra` (multi-agent cloud review) for substantial
  features before merge — it's billed separately, so don't run it routinely.
- `/code-review --fix` applies the findings directly if you want them
  auto-fixed instead of just reported.
- If a diff feels too big or risky for a single `/quick-review` pass, say so
  and let the user decide whether to budget for the full fan-out — don't
  quietly spawn sub-agents to compensate.

### Security review
The standard review lenses (correctness, cleanup, altitude, conventions) are
not a substitute for an explicit security pass — they check whether a change
does what it intends, not whether an adversary can bend it. This repo's
finding-rendering path (`adk/frontend/app.js`'s `renderFindings`) escapes some
LLM/diff-derived fields but not others, and PR diff filenames flowing into
that path are attacker-controlled — the kind of gap that only surfaces with
that specific adversarial lens.

- Run **`/security-review`** (project skill, `.claude/skills/security-review/`)
  as an optional, additive pass — not a replacement for `/quick-review` —
  whenever a diff touches agent orchestration, storage/secrets, auth, or how
  externally-influenced content (PR diffs, Gemini/LLM output) gets rendered,
  parsed, or escaped. It runs adversarial angles (injection, auth/authz,
  secrets handling, supply chain) the standard lenses don't cover, as a
  single inline pass (no sub-agents, ~1 call) — same quota profile as
  `/quick-review`.

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
- **Never merge a PR or push directly to `main`, even a trivial one** —
  merges to `main` auto-deploy via `deploy.yml`, and a self-merge has no
  human review behind it. Open the PR and hand it to the user; only a human
  merges. (The harness backstops this — `gh pr merge` on a self-authored PR
  gets blocked as a self-merge-without-review — but don't attempt to work
  around that block, and don't rely on it instead of just not trying.)

## Conventions
- Storage is accessed only through `storage.ts`'s exported functions in each
  package; add capabilities there, don't instantiate `S3Client` in callers.
- Don't reintroduce Vertex AI / ADC / `GOOGLE_APPLICATION_CREDENTIALS` —
  Gemini access is API-key-only now (`GEMINI_API_KEY`).
- `local_vs_branch` / `branch_vs_production` eval comparisons require a
  manually deployed staging URL (`STAGING_URL` env var) — the old
  Cloud-Build auto-deploy-a-branch flow has no Fly equivalent and was
  removed, not replaced.
