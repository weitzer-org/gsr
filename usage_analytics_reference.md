# Usage analytics reference

How LLM call data (tokens, latency, cost, success/failure) is captured for
this repo, and where to find it — written so a future session (human or AI)
can answer a cost/latency/error-rate question directly from R2/MinIO without
building a dashboard first. This is the GSR counterpart of the identical
pattern in the sibling `job_tracker` and `sound-profile-builder` projects —
all three deliberately share the same storage layout and record schema, so
query recipes are interchangeable across projects.

## What's captured, and by what

Every real Gemini `generateContent` call in `adk/backend` is wrapped by
`trackGeminiCall` (`adk/backend/src/usage.ts`), which measures latency,
extracts token usage, computes cost, and writes one record — success or
failure — before returning/rethrowing:

| Call | File | `callType` |
|---|---|---|
| Legacy per-file review pass | `agent.ts` (`analyzeLegacy`) | `legacy` |
| Discovery pass (per retry iteration) | `agent.ts` (`analyze`) | `discovery` |
| Remediation pass | `agent.ts` (`analyze`) | `remediation` |
| Findings deduplication | `deduplicator.ts` | `deduplicate` |
| Subagent-vs-basic comparison narrative | `evaluator.ts` | `evaluate` |

A **failed** call is logged too (`success: false`, zero tokens, a coarse
`errorKind` — `rate_limit`, `auth`, `unavailable`, `timeout`, or
`api_error` — see `classifyError` in `usage.ts`), not just successful ones.
`trackGeminiCall` only *observes* each call — it rethrows the original error
unchanged, so it never affects the existing retry/timeout logic already
wrapped around each call site (the discovery loop's retry-on-missed-files,
the `Promise.race` timeouts in `agent.ts`/`deduplicator.ts`).

### `tools/eval`'s own usage tracking

`tools/eval` (the separately-deployed `gsr-evaluator` Fly app, but just as
often run directly on a developer's laptop via `npm run eval`) has its own
Gemini judge calls in `llm-comparator.ts`/`llm-comparator-v2.ts`
(`callType`s `llm_compare`, `llm_compare_aggregate`, `llm_compare_v2`,
`llm_compare_v2_aggregate`), tracked by a **separate, parallel** module,
`tools/eval/usage.ts` — not a shared import of this file, since `tools/eval`
is an independently deployed service with its own `storage.ts`. Every call
is recorded **twice, unconditionally**:

1. **Locally**: written under `usage/<date>/...` in `tools/eval`'s own
   bucket (`S3_BUCKET`, default `gsr-eval-results` — MinIO locally, R2 when
   actually deployed as `gsr-evaluator`), each tagged
   `repository: 'tools-eval (local)'`. This is what the *local* dashboard
   (a locally-running `adk/backend` pointed at the same MinIO) reads.
2. **To production**: POSTed to the hosted backend's `POST /api/usage/ingest`
   (`tools/eval/usage.ts` reuses `adk/backend/src/usageReporter.ts`'s
   `reportUsage()` — the exact same helper a GitHub Action uses to report
   review usage, not a second HTTP client), authenticated with
   `USAGE_INGEST_SHARED_SECRET`. This is what makes a run on *anyone's*
   laptop show up on the shared production dashboard, without needing to
   hand out real R2 write credentials to every machine that runs the eval
   harness. If the shared secret isn't configured, this half is skipped
   (logged once, never fails the run) — the local write still happens
   either way.

The dashboard (`GET /api/usage/summary`, below) reads local-bucket data by
having `adk/backend/src/usage.ts`'s `listUsageRecords`/`getOrBuildDayRollup`
take a `bucket` parameter, rather than importing `tools/eval/usage.ts`
directly (that would put a file outside `adk/backend`'s TypeScript `rootDir`
and break its production `tsc` build) — production-reported records need no
such trick, since they land in `adk/backend`'s own bucket via the normal
ingest path, indistinguishable from a GitHub Action's reported batch except
for the `repository` tag. Its `workloadOf()` treats any `callType` starting
with
`llm_compare` as `"eval"` workload, alongside its own `evaluate` callType —
**this is a distinct concept from the `eval-harness` *source*** described
below: the workload split says *what kind of work* a call did (review vs.
eval vs. product, purely `callType`-derived); the source says *which
service* made the call (`adk/backend` vs. `tools/eval`). Don't conflate
them — a query can filter by one, the other, or both.

### job_tracker's and sound-profile-builder's own native usage

Beyond the GSR GitHub Action reviewing their PRs (which reports usage the
same way any other consuming project's Action run does — tagged with that
project's `repository` string, classified as `"review"` workload), both
`job_tracker` and `sound-profile-builder` also report their own **native,
product-feature** Gemini usage (job_tracker's resume/JD/candidate scoring;
sound-profile-builder's audio-analysis agents) into this same dashboard:

- Each project has its own `Reporter`-style component
  (`internal/usage/reporter.go` in job_tracker,
  `internal/agents/usage_reporter.go` in sound-profile-builder) that
  translates its own usage-event shape into GSR's exact ingest JSON, filters
  out any non-`"gemini"` `provider` (both codebases also carry
  `"anthropic"`/`"fallback"`/`"mock"`/`"openllm"` providers that GSR's
  ingest would otherwise silently reject), and POSTs to `POST
  /api/usage/ingest` through a small bounded worker pool — a non-blocking
  enqueue from the request-handling path, not a synchronous call and not an
  unbounded goroutine per call. Reports are best-effort and can be lost on a
  deploy/restart, an accepted tradeoff for a non-blocking analytics
  side-channel.
- Tagged `repository: "weitzer-org/job_tracker"` /
  `repository: "weitzer-org/sound-profile-builder"` — the real GitHub
  slugs, **not** either project's Go module path (which differs for
  sound-profile-builder: `github.com/weitzer-org/sound-builder`).
- Since neither project's `callType` vocabulary overlaps GSR's own known
  review/eval callTypes, `workloadOf()` classifies all of it as `"product"`
  automatically — see the `byWorkload` bullet below.
- Each project's own runtime needs `GSR_USAGE_INGEST_URL`/
  `GSR_USAGE_INGEST_KEY` (or equivalent) set as real secrets on **that
  project's own deployment** for live reporting to activate — GSR-side code
  changes alone don't turn this on.
- Historical data from before this reporting existed was backfilled once via
  a standalone script that lists each project's own bucket, filters to
  `provider === "gemini"`, translates field names the same way the live
  reporters do, and batch-POSTs to the same ingest endpoint — keying objects
  by each record's own historical `timestamp` (see `ingestUsageRecords`'s
  date-key derivation below), not the date the backfill script happened to
  run.

### What's NOT covered

- No `refId` (e.g. the PR URL) is threaded through yet — `Orchestrator.
  runReview`/`GeminiAgent.analyze`/`DeduplicatorAgent.deduplicate`/
  `Evaluator.evaluateComparison` don't currently receive one. A record can be
  correlated to *what kind* of call it was and *when*, but not yet to *which
  PR review* it belonged to. Threading the PR URL down through those four
  layers would be a reasonable follow-up, not done here to keep this change
  a pure instrumentation add with no signature changes to existing methods.
- The one-off `countTokens`/`caches.create` calls in `agent.ts`'s context-
  caching setup aren't tracked — they don't produce billable
  input/output tokens the same way `generateContent` does, so there's
  nothing meaningful to attribute cost to; only the actual content-
  generation calls are in scope, mirroring `job_tracker`'s equivalent
  scope boundary (it tracks `scoring.Provider` calls, not every API call in
  the app).

## Where the data lives

```
usage/{YYYY-MM-DD}/{HHMMSSmmm}-{8 hex chars}.json   — one object per call attempt
usage/rollups/{YYYY-MM-DD}.json                      — optional persisted daily aggregate
```

Both live in `S3_REVIEW_BUCKET` (the same bucket `review-run_*.json` history
already lives in) for every `adk/backend` call site — including
`test_deduplicator.ts`/`debug-single.ts`, the two local debug scripts, now
also wrapped in `trackGeminiCall`. `tools/eval`'s own calls land under the
identical `usage/<date>/...` layout, but in **`tools/eval`'s own bucket**
(`S3_BUCKET`, default `gsr-eval-results`) — see "`tools/eval`'s own usage
tracking" above. Per-call objects are written unconditionally — no
read-modify-write, so `Orchestrator`'s bounded-concurrency subagent calls
(`PromisePool`, up to 5 in flight) never contend writing them. A rollup is a
recomputed summary, not an append-only log: writing one for a date
overwrites whatever was there before.

Rollups are no longer purely a manual `usage-report.js --write-rollup`
artifact — `GET /api/usage/summary` (see "Reading it via the dashboard"
below) lazily builds and caches one for any past date the first time it's
queried, self-healing a missing or stale-`schemaVersion` cache
automatically. `usage-report.js --write-rollup` still works as a manual
alternative; just note both paths write the same `usage/rollups/<date>.json`
key, so whichever ran most recently wins.

`ingestUsageRecords` (the write path behind `POST /api/usage/ingest`) keys
each object under the date derived from **the record's own `timestamp`
field**, not the moment the batch happens to be POSTed — a live reporter's
batch can lag the actual Gemini call by seconds, and a historical backfill
can lag it by months. Keying by "now" instead would silently file every
ingested record under today's prefix regardless of when the underlying call
actually ran (the exact bug class already fixed in `tools/eval`'s own local
writer). An unparsable `timestamp` falls back to "now" with a logged
warning, so a malformed record still lands somewhere findable instead of
being silently dropped.

**Gotcha, proven twice now: nothing about writing new data, or fixing a bug
in how it's read, retroactively touches an already-cached rollup — only a
`CURRENT_SCHEMA_VERSION` bump forces a rebuild.**

1. `ingestUsageRecords` never invalidates a date's cached rollup. If a past
   date was already queried (and therefore cached — see above) *before* a
   backfill writes new records into that same date, the cached rollup keeps
   serving its pre-backfill values indefinitely; only `date >= today` is
   ever recomputed live. This bit the 2026-08-30 job_tracker/
   sound-profile-builder backfill: its own idempotency check (which queries
   the target range *before* writing, by design — see the backfill section
   further down) had already cached mostly-empty rollups for the entire
   range moments before the real records landed, silently hiding thousands
   of newly-backfilled calls from the dashboard.
2. The same is true of a *read-path* bug fix, not just new writes. Fixing
   `listFiles`'s missing pagination (it silently dropped everything past
   S3's 1000-key-per-response cap) didn't help any date whose rollup had
   already been cached — at the current schema version — while the bug was
   still live. Confirmed in production: 2026-08-09's cached rollup kept
   showing exactly 1000 job_tracker calls (the cap) for days *after* the
   pagination fix deployed, against 1124 real records, because nothing
   forced that specific cache entry to rebuild.

Both were fixed by bumping `CURRENT_SCHEMA_VERSION` (forces every cached
rollup to rebuild once against current code), but the underlying gap is
structural and will recur: **any deploy that changes what a rollup for an
already-cached past date *should* contain — a backfill, a classification
change, a read-path correctness fix — needs its own `CURRENT_SCHEMA_VERSION`
bump**, even if the Rollup type's shape didn't change at all. Bumping the
schema version is cheap (every past-day rollup just rebuilds once on next
read); forgetting it is what silently freezes wrong numbers in place.
Alternative, if write credentials to the bucket are available: run
`usage-report.js --from <start> --to <end> --write-rollup` against
production immediately after the fix/backfill deploys, before anyone
queries that range again — narrower and avoids a version bump, but easy to
get the range wrong.

## Record schema

```jsonc
{
  "timestamp": "2026-07-29T20:13:53.282Z",   // ISO 8601, UTC
  "provider": "gemini",
  "callType": "discovery",                    // see table above
  "refId": undefined,                         // not populated yet — see "What's NOT covered"
  "model": "gemini-3.1-pro-preview",
  "inputTokens": 1345,
  "outputTokens": 210,
  "cachedTokens": 0,                          // present only when > 0
  "thinkingTokens": 0,                        // present only when > 0 — usageMetadata.thoughtsTokenCount
  "latencyMs": 2431,
  "costUsd": 0.0034,
  "finishReason": undefined,                  // not currently populated by trackGeminiCall
  "success": true,                            // always present, even when false
  "errorKind": "rate_limit"                   // present only when success is false
}
```

## Reading it via the dashboard

**Preferred for day/week/month/range questions:** `GET /api/usage/summary`
(behind the normal session gate, like the rest of the dashboard) —

```http
GET /api/usage/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month&source=all|backend|eval-harness
```

`source=backend` reads only `S3_REVIEW_BUCKET`; `source=eval-harness` reads
only `tools/eval`'s bucket; `source=all` (default) merges both. Returns
`{ granularity, source, buckets: Rollup[], total: Rollup }` — `buckets` is
one `Rollup` per day/week/month in range, `total` is the whole range summed.
Backed by `getOrBuildDayRollup`/`sumRollups` in `adk/backend/src/usage.ts` —
see the Rollup schema below for the full shape, including the `byRepository`/
`byWorkload`/intersection breakdowns the dashboard's UI (`usage.html`) reads
directly. The frontend page itself lives at `/usage.html` (linked from the
nav bar on every dashboard page).

## How to query it directly

**`usage-report.js`** (repo root) is still a valid scriptable alternative —
handles listing, decoding, and aggregating for you, without going through
the app:

```bash
node usage-report.js                                   # today, UTC
node usage-report.js --date 2026-07-29
node usage-report.js --from 2026-07-23 --to 2026-07-29  # range + a combined total
node usage-report.js --date 2026-07-29 --write-rollup   # also persist the rollup
```

Needs `S3_REVIEW_BUCKET` (or the default `gsr-review-results`/
`gsr-review-results-local`) and real storage credentials in the environment
— same `S3_*` vars `adk/backend` and `tools/eval` use. Prints total
calls/tokens/cost/avg latency plus breakdowns by call type, model, and error
kind. Report-only by default; `--write-rollup` is the only thing that writes
anything.

**Ad hoc queries the script doesn't cover** — read the raw objects directly
and pipe through `jq`, the same way `list-gcs.js`/`summarize.js` in this
directory do ad hoc debugging:

```bash
# Via the aws CLI + S3_* env vars (works against MinIO locally or real R2):
aws s3api list-objects-v2 --endpoint-url "$S3_ENDPOINT" --bucket "$S3_REVIEW_BUCKET" \
  --prefix "usage/2026-07-29/" --query 'Contents[].Key' --output text | tr '\t' '\n' | \
while read -r key; do [ -n "$key" ] && [ "$key" != "None" ] && aws s3 cp --endpoint-url "$S3_ENDPOINT" "s3://$S3_REVIEW_BUCKET/$key" -; done | jq -s '
  group_by(.callType) | map({callType: .[0].callType, totalCost: (map(.costUsd) | add)})'
```

(`--output text` prints the literal string `None` when no objects matched
the prefix — the `[ "$key" != "None" ]` guard avoids a spurious `aws s3 cp`
of a nonexistent `None` object in that case.)

Swap the `jq` filter for whatever question you're answering (`select(.success
== false)` for an error-rate check, `sort_by(.latencyMs) | .[-1]` for the
slowest call, etc.). If `aws`/`mc` aren't available in the environment,
`tools/eval/usage-report-client.js`'s `listFiles`/`downloadJson` are the
programmatic fallback — write a one-off `node -e "..."` snippet calling them
directly rather than reinventing the S3 listing/reading logic.

## Rollup schema (written by `--write-rollup` or `getOrBuildDayRollup`'s cache)

```jsonc
{
  "schemaVersion": 5,                         // bumped whenever this shape/classification changes, OR a past date's underlying records changed after caching (see the backfill gotcha above) — a cached rollup at an older version is rebuilt on next read
  "date": "2026-07-29",                       // a day ("2026-07-29"), an ISO week ("2026-W31"), a month ("2026-07"), or a range label ("2026-07-01..2026-07-29") for a summed Rollup
  "totalCalls": 42, "successCount": 40, "failureCount": 2,
  "totalInputTokens": 58000, "totalOutputTokens": 9200, "totalThinkingTokens": 400,
  "totalCostUsd": 0.87, "totalLatencyMs": 88342.8, "avgLatencyMs": 2103.4,
  "byCallType": { "discovery": { "calls": 38, "successCount": 37, "failureCount": 1, "inputTokens": 51000, "outputTokens": 8100, "thinkingTokens": 400, "costUsd": 0.79 }, "...": "..." },
  "byModel":    { "gemini-3.1-pro-preview": { "...": "..." } },
  "byErrorKind": { "rate_limit": 2 },
  "byRepository": { "gsr (hosted)": { "...": "..." }, "weitzer-org/logo-maker": { "...": "..." }, "tools-eval (local)": { "...": "..." }, "weitzer-org/job_tracker": { "...": "..." }, "weitzer-org/sound-profile-builder": { "...": "..." } },
  "byWorkload": { "review": { "...": "..." }, "eval": { "...": "..." }, "product": { "...": "..." } },
  "byModelRepository": { "gemini-3.1-pro-preview|gsr (hosted)": { "...": "..." } },
  "byModelWorkload": { "gemini-3.1-pro-preview|review": { "...": "..." } },
  "byRepositoryWorkload": { "gsr (hosted)|review": { "...": "..." } }
}
```

- `byRepository` ("consuming project") defaults a record with no `repository`
  field to `"gsr (hosted)"` — applied only at aggregation time, never written
  into the raw stored record.
- `byWorkload` has three keys: `"review"`, `"eval"`, and `"product"`.
  `"eval"` covers `callType === "evaluate"` (adk/backend's own Evaluator) and
  any `callType` starting with `"llm_compare"` (tools/eval's calls);
  `"review"` is an explicit allowlist of GSR's own known review/debug
  callTypes (`legacy`, `discovery`, `remediation`, `deduplicate`,
  `feedback_classify`, `feedback_adjudicate`, `debug_test_deduplicator`,
  `debug_single` — see `KNOWN_REVIEW_CALL_TYPES` in `usage.ts`); everything
  else — including job_tracker's fixed CallType vocabulary and
  sound-profile-builder's free-text agent-role callTypes — is `"product"`.
  **Invariant:** `KNOWN_REVIEW_CALL_TYPES` must never overlap with any
  ingested source's own callType vocabulary — that's what lets a new
  reporter push usage here without GSR needing to learn its callTypes first.
  See "`tools/eval`'s own usage tracking" and "job_tracker's and
  sound-profile-builder's own native usage" above for why this classification
  is a different concept from the `source=backend|eval-harness` dashboard
  filter.
- **Cross-project `costUsd` totals blend independently-computed pricing
  methodologies.** `ingestUsageRecords` stores `costUsd` exactly as sent by
  the reporting side — it never recomputes it via GSR's own
  `computeCostUsd`. GSR, job_tracker, and sound-profile-builder each keep
  their own pricing table and don't bill cached/thinking tokens identically
  (e.g. GSR treats `thinkingTokens` as pure telemetry, never added to
  `costUsd` — see below). A `totalCostUsd` that sums across repositories is
  therefore a best-effort blend, not an apples-to-apples figure — fine for a
  rough trend line, not for precise cross-project cost accounting.
- The three `by<A><B>` intersection maps key on `"<a>|<b>"` (`|` is safe:
  model names, `owner/repo` strings, and the two workload labels never
  contain it), built only from combinations actually observed in the
  aggregated records, not a full cross-product of every distinct value.
- **`thinkingTokens` is telemetry, not part of `costUsd`**: `computeCostUsd`
  (in both `adk/backend/src/usage.ts` and `tools/eval/usage.ts`) bills only
  `inputTokens`/`outputTokens` — it deliberately does NOT add `thinkingTokens`
  on top. Gemini's own pricing page describes the output rate as already
  "including thinking tokens," and multiple developer reports (Google's AI
  forum has several threads on this exact question, with answers that
  differ across models/API versions) suggest `candidatesTokenCount` — this
  file's `outputTokens` — may already reflect them for the models in
  `PRICE_TABLE`. Adding `thinkingTokens` again would risk double-billing.
  Re-verify against current per-model docs before changing this.
