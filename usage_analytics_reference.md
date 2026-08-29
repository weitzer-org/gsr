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

`tools/eval` (the separately-deployed `gsr-evaluator` Fly app) has its own
Gemini judge calls in `llm-comparator.ts`/`llm-comparator-v2.ts`
(`callType`s `llm_compare`, `llm_compare_aggregate`, `llm_compare_v2`,
`llm_compare_v2_aggregate`), tracked by a **separate, parallel** module,
`tools/eval/usage.ts` — not a shared import of this file, since `tools/eval`
is an independently deployed service with its own `storage.ts`. Its records
land under `usage/<date>/...` in **`tools/eval`'s own bucket** (`S3_BUCKET`,
default `gsr-eval-results`), each tagged `repository: 'tools-eval (local)'`.

The dashboard (`GET /api/usage/summary`, below) reads both buckets and
merges them — `adk/backend/src/usage.ts`'s `listUsageRecords`/
`getOrBuildDayRollup` take a `bucket` parameter for exactly this, rather than
this file importing `tools/eval/usage.ts` directly (that would put a file
outside `adk/backend`'s TypeScript `rootDir` and break its production
`tsc` build). Its `workloadOf()` treats any `callType` starting with
`llm_compare` as `"eval"` workload, alongside its own `evaluate` callType —
**this is a distinct concept from the `eval-harness` *source*** described
below: the workload split says *what kind of work* a call did (review vs.
eval, purely `callType`-derived); the source says *which service* made the
call (`adk/backend` vs. `tools/eval`). Don't conflate them — a query can
filter by one, the other, or both.

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

```
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
  "schemaVersion": 2,                         // bumped whenever this shape changes; a cached rollup at an older version is rebuilt on next read
  "date": "2026-07-29",                       // a day ("2026-07-29"), an ISO week ("2026-W31"), a month ("2026-07"), or a range label ("2026-07-01..2026-07-29") for a summed Rollup
  "totalCalls": 42, "successCount": 40, "failureCount": 2,
  "totalInputTokens": 58000, "totalOutputTokens": 9200, "totalThinkingTokens": 400,
  "totalCostUsd": 0.87, "totalLatencyMs": 88342.8, "avgLatencyMs": 2103.4,
  "byCallType": { "discovery": { "calls": 38, "successCount": 37, "failureCount": 1, "inputTokens": 51000, "outputTokens": 8100, "thinkingTokens": 400, "costUsd": 0.79 }, "...": "..." },
  "byModel":    { "gemini-3.1-pro-preview": { "...": "..." } },
  "byErrorKind": { "rate_limit": 2 },
  "byRepository": { "gsr (hosted)": { "...": "..." }, "weitzer-org/logo-maker": { "...": "..." }, "tools-eval (local)": { "...": "..." } },
  "byWorkload": { "review": { "...": "..." }, "eval": { "...": "..." } },
  "byModelRepository": { "gemini-3.1-pro-preview|gsr (hosted)": { "...": "..." } },
  "byModelWorkload": { "gemini-3.1-pro-preview|review": { "...": "..." } },
  "byRepositoryWorkload": { "gsr (hosted)|review": { "...": "..." } }
}
```

- `byRepository` ("consuming project") defaults a record with no `repository`
  field to `"gsr (hosted)"` — applied only at aggregation time, never written
  into the raw stored record.
- `byWorkload` is exactly two keys, `"review"` and `"eval"` — `"eval"` covers
  `callType === "evaluate"` (adk/backend's own Evaluator) and any `callType`
  starting with `"llm_compare"` (tools/eval's calls); everything else is
  `"review"`. See "`tools/eval`'s own usage tracking" above for why this is
  a different concept from the `source=backend|eval-harness` dashboard
  filter.
- The three `by<A><B>` intersection maps key on `"<a>|<b>"` (`|` is safe:
  model names, `owner/repo` strings, and the two workload labels never
  contain it), built only from combinations actually observed in the
  aggregated records, not a full cross-product of every distinct value.
- **Thinking-token pricing is an unverified assumption**: `computeCostUsd`
  (in both `adk/backend/src/usage.ts` and `tools/eval/usage.ts`) bills
  `thinkingTokens` at the model's output rate. Re-check against current
  Gemini pricing before treating `totalCostUsd` as authoritative for a
  thinking-heavy workload.
