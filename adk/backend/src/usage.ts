// Persists per-Gemini-call token/latency/cost/success records to object
// storage for cost analytics — the same pattern built for the sibling
// job_tracker and sound-profile-builder projects (all three share the same
// storage-layout convention deliberately, so the query recipes/tooling are
// interchangeable across projects).
//
// Every real call site (agent.ts, deduplicator.ts, evaluator.ts) already
// reads `response.usageMetadata` and computes latency inline, but that data
// was only ever logged to the console or aggregated in-memory for the
// current run — never persisted durably. trackGeminiCall wraps the actual
// `generateContent` call so each call site gets durable recording with a
// one-line change, without disturbing the retry/timeout logic already
// wrapped around it at each site.
//
// Storage layout: one small JSON object per call under
// usage/<date>/<time>-<rand>.json in S3_REVIEW_BUCKET (the same bucket
// review-run history already lives in) — no read-modify-write, so
// concurrent subagent calls (Orchestrator's PromisePool, up to 5 in flight)
// never contend the way a single shared/appended file would.
import { randomBytes } from 'crypto';
import { uploadJson, listFiles, getFileStream, getFileJson } from './storage';
import { PromisePool } from './pool';

export interface UsageEvent {
  callType: string; // e.g. "legacy", "discovery", "remediation", "deduplicate", "evaluate",
                     // "feedback_classify" (PR comment feedback loop Phase 1, adjudicator.ts),
                     // "feedback_adjudicate" (Phase 2 "respond", adjudicator.ts's adjudicate()).
  refId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  thinkingTokens?: number; // present only when > 0 — Gemini's usageMetadata.thoughtsTokenCount
  latencyMs: number;
  costUsd: number;
  finishReason?: string;
  success: boolean;
  errorKind?: string; // set only when success is false
  repository?: string; // "owner/repo" — set only via ingestUsageRecords() for
                        // batches reported from a GitHub Action run;
                        // undefined for the hosted backend's own calls.
}

export interface UsageRecord extends UsageEvent {
  timestamp: string; // ISO 8601, UTC
  provider: 'gemini';
}

// USD per 1,000,000 tokens. Mirrors the pricing table used by the sibling
// job_tracker project (internal/scoring/pricing.go) — keep them in sync when
// prices change. An unknown model returns 0 cost, a signal to add it here,
// not "this call was free."
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
  'gemini-3.7-flash': { input: 0.75, output: 3.75 }, // introductory rate through 2026-12-31; doubles to 1.50/7.50 after
  'gemini-2.5-pro': { input: 1.25, output: 10.0 }, // used by debug-single.ts and tools/eval's llm-comparator*.ts; <=200k-token-prompt tier — verify against current pricing if usage grows large
};

// thinkingTokens is NOT added to outputTokens here — Gemini's own pricing
// page describes the output rate as already "including thinking tokens",
// and multiple developer reports (Google's own AI forum has several threads
// asking this exact question, with inconsistent answers across models/API
// versions) suggest `candidatesTokenCount` (this file's `outputTokens`) may
// already reflect them for the models in PRICE_TABLE. Adding thinkingTokens
// on top risks double-billing; it's tracked in UsageRecord/UsageBucket
// purely as an observability metric, not folded into cost. Re-verify against
// current per-model docs before changing this.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const perM = 1_000_000;
  const billedInput = Math.max(0, inputTokens - cachedTokens);
  return (billedInput * price.input) / perM + (outputTokens * price.output) / perM;
}

// classifyError gives a coarse, stable label for a failed call so usage
// records can be aggregated by failure reason without string-matching error
// text ad hoc at query time. @google/genai/fetch errors don't have one
// consistent shape across every failure mode this repo's call sites can hit
// (SDK HTTP errors, the hand-rolled ETIMEDOUT Promise.race timeouts in
// agent.ts/deduplicator.ts), so this inspects the common signals — an HTTP
// status if present, otherwise the message text — rather than assuming a
// single error class.
export function classifyError(err: unknown): string {
  const anyErr = err as { status?: number; code?: number; response?: { status?: number }; message?: string } | undefined;
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (typeof status === 'number' && status >= 500) return 'unavailable';
  const message = String(anyErr?.message ?? err ?? '');
  if (/etimedout|timed?\s?out|deadline/i.test(message)) return 'timeout';
  return 'api_error';
}

function getUsageBucketName(): string {
  return process.env.S3_REVIEW_BUCKET || 'gsr-review-results';
}

// objectKey builds usage/<YYYY-MM-DD>/<HHMMSSmmm>-<8 hex chars>.json. The
// random suffix guarantees uniqueness even for two calls completing within
// the same millisecond — an unconditional PUT would otherwise silently
// overwrite the earlier record instead of erroring.
function objectKey(date: Date): string {
  const iso = date.toISOString(); // e.g. "2026-07-29T20:13:53.282Z"
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 23).replace(/[:.]/g, '');
  const rand = randomBytes(4).toString('hex');
  return `usage/${day}/${time}-${rand}.json`;
}

export type UsageSink = (record: UsageRecord) => void | Promise<void>;

async function defaultSink(record: UsageRecord): Promise<void> {
  await uploadJson(getUsageBucketName(), objectKey(new Date()), record);
}

let sink: UsageSink = defaultSink;

// setUsageSink lets a caller (currently only action-entrypoint.ts) redirect
// every recordUsage() call for the rest of the process's lifetime — e.g.
// into an in-memory array instead of S3, since a GitHub Action's runner has
// no S3_* credentials. Deliberately a module-level override rather than
// threading a sink through GeminiAgent/DeduplicatorAgent/Orchestrator: those
// classes are constructed many times per review (one GeminiAgent per
// subagent/file) with no natural single injection point, and trackGeminiCall
// already only ever calls this module's recordUsage directly.
export function setUsageSink(newSink: UsageSink): void {
  sink = newSink;
}

// resetUsageSink restores the default S3 sink. Tests must call this after
// setUsageSink — sink is module-global state that would otherwise leak into
// later tests sharing the same module instance.
export function resetUsageSink(): void {
  sink = defaultSink;
}

// recordUsage never throws — a broken/unreachable sink must never turn a
// dropped analytics record into a failed review. A write failure is logged
// and the record dropped, mirroring internal/usage.Store.Record's contract
// in the sibling job_tracker project.
export async function recordUsage(event: UsageEvent): Promise<void> {
  const record: UsageRecord = { ...event, provider: 'gemini', timestamp: new Date().toISOString() };
  try {
    await sink(record);
  } catch (err) {
    console.error('[usage] failed to record usage event:', err);
  }
}

type GenerateContentLikeResponse = {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  candidates?: Array<{ finishReason?: string }>;
};

// trackGeminiCall wraps a single `ai.models.generateContent(...)` call (or
// anything returning a `{ usageMetadata, ... }`-shaped response) so latency,
// tokens, cost, and success/failure are captured with a one-line change at
// the call site — see agent.ts/deduplicator.ts/evaluator.ts.
//
// A failed call is recorded too (success: false, zero tokens, a classified
// errorKind, but a real latency-to-failure) before the error is rethrown
// unchanged, so the existing retry/timeout logic wrapped around each call
// site is completely unaffected — this only observes the call, it never
// changes its outcome.
export async function trackGeminiCall<T extends GenerateContentLikeResponse>(
  ctx: { callType: string; model: string; refId?: string },
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    const response = await fn();
    const latencyMs = Date.now() - start;
    const u = response.usageMetadata;
    const inputTokens = u?.promptTokenCount ?? 0;
    const outputTokens = u?.candidatesTokenCount ?? 0;
    const cachedTokens = u?.cachedContentTokenCount ?? 0;
    const thinkingTokens = u?.thoughtsTokenCount ?? 0;
    await recordUsage({
      callType: ctx.callType,
      refId: ctx.refId,
      model: ctx.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      thinkingTokens,
      latencyMs,
      costUsd: computeCostUsd(ctx.model, inputTokens, outputTokens, cachedTokens),
      finishReason: response.candidates?.[0]?.finishReason,
      success: true,
    });
    return response;
  } catch (err) {
    const latencyMs = Date.now() - start;
    await recordUsage({
      callType: ctx.callType,
      refId: ctx.refId,
      model: ctx.model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      costUsd: 0,
      success: false,
      errorKind: classifyError(err),
    });
    throw err;
  }
}

// recordParseFailure records that a call's response.text failed to
// JSON.parse — a distinct failure mode from trackGeminiCall's own catch,
// which only sees network/API-level errors. Previously, agent.ts's
// JSON.parse calls happened outside trackGeminiCall entirely: a parse
// failure was silently caught by analyze()'s outer catch and turned into
// `{ findings: [] }` with no error propagated — indistinguishable in every
// existing metric from "this agent legitimately found nothing." Call this
// from that catch so the failure is visible in the same usage analytics as
// every other failure kind, without changing analyze()'s graceful-degradation
// behavior (the caller still gets `{ findings: [] }`; this only makes the
// underlying cause visible after the fact).
//
// costUsd is deliberately 0 here, not the real cost of the underlying call:
// trackGeminiCall already recorded that call as a success (the generateContent
// request itself really did succeed and was billed) before this ever runs. A
// second full-cost record for the same call would double it in every
// aggregate. Token counts and finishReason are preserved for diagnosis (e.g.
// distinguishing a MAX_TOKENS truncation from a genuinely malformed response)
// without double-billing.
export async function recordParseFailure(
  ctx: { callType: string; model: string; refId?: string },
  response: GenerateContentLikeResponse,
  latencyMs: number
): Promise<void> {
  const u = response.usageMetadata;
  await recordUsage({
    callType: ctx.callType,
    refId: ctx.refId,
    model: ctx.model,
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
    cachedTokens: u?.cachedContentTokenCount ?? 0,
    thinkingTokens: u?.thoughtsTokenCount ?? 0,
    latencyMs,
    costUsd: 0,
    finishReason: response.candidates?.[0]?.finishReason,
    success: false,
    errorKind: 'parse_error',
  });
}

// --- Rollup aggregation, mirroring internal/usage's Aggregate/ListRecords
// in the sibling job_tracker project. ---

export interface UsageBucket {
  calls: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number;
}

// Bumped whenever Rollup's shape OR classification semantics change, OR
// whenever a past date's underlying records changed after that date's
// rollup was already cached. getOrBuildDayRollup (below) uses this to
// detect a cached usage/rollups/<date>.json written by an out-of-sync
// producer (an older deploy, or a manual `usage-report.js --write-rollup`
// run whose own hand-copied aggregate() hasn't been updated to match) and
// transparently rebuild it instead of serving a stale shape.
//
// Bumped to 3 when workloadOf() gained the "product" classification — a
// cached rollup built under the old binary eval/review split would
// otherwise keep serving that stale split forever, since its shape
// (Rollup's fields) didn't change, only its values.
//
// Bumped to 4 after the one-time job_tracker/sound-profile-builder native-
// usage backfill (2026-08-30): ingestUsageRecords writes raw per-call
// objects but never invalidates a date's cached rollup, so every past date
// in the backfilled range that anyone had already queried before the
// backfill ran (this backfill's own idempotency check included) kept
// serving its pre-backfill cached rollup indefinitely even after real
// records existed underneath it. This bump forces every cached rollup to
// rebuild once, picking up the backfilled data. A future backfill into an
// already-queried date range will hit the same gap — see
// usage_analytics_reference.md's backfill section for the mitigation
// (query the target range for the first time only after the writes land).
export const CURRENT_SCHEMA_VERSION = 4;

// byModelRepository/byModelWorkload/byRepositoryWorkload key their maps on
// `${a}|${b}` — safe because model names, "owner/repo" repository strings,
// and the two workload labels ("eval"/"review") never contain "|".
export interface Rollup {
  schemaVersion: number;
  date: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  byCallType: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byErrorKind: Record<string, number>;
  byRepository: Record<string, UsageBucket>;
  byWorkload: Record<string, UsageBucket>;
  byModelRepository: Record<string, UsageBucket>;
  byModelWorkload: Record<string, UsageBucket>;
  byRepositoryWorkload: Record<string, UsageBucket>;
}

// UNTAGGED_REPOSITORY_LABEL is applied only during aggregation, never
// written into a stored raw record — a record with no `repository` really
// did have none reported, and callers reading raw records directly (e.g.
// listUsageRecords) should keep seeing that truthfully. Only the
// "consuming project" breakdown needs every record bucketed somewhere.
const UNTAGGED_REPOSITORY_LABEL = 'gsr (hosted)';

// "eval" covers adk/backend's own `evaluate` callType (the Evaluator
// subagent-vs-basic comparison narrative) AND tools/eval's `llm_compare`/
// `llm_compare_v2` (+ `_aggregate`) callTypes — the latter written by the
// separate gsr-evaluator service's tools/eval/usage.ts into its own bucket,
// read here via listUsageRecords/getOrBuildDayRollup's bucket parameter
// rather than a shared module.
//
// "review" is an explicit allowlist of GSR's own known review/debug
// callTypes, NOT a denylist of everything job_tracker/sound-profile-builder
// might send — sound-profile-builder's callType is an open-ended free-text
// agent-role string (e.g. "Tone Historian"), so a denylist couldn't work for
// it anyway. Everything that isn't "eval" or one of these known GSR
// callTypes is "product": job_tracker's/sound-profile-builder's own native
// Gemini usage, reported via the same ingest path review-usage already uses
// (see ingestUsageRecords below).
//
// INVARIANT: this Set must never overlap with any ingested source's own
// callType vocabulary — that's what lets a new reporter push usage here
// without GSR needing to learn its callTypes first. Confirmed disjoint from
// job_tracker's (score_job, parse_jd, score_candidate, judge,
// company_research, company_url_lookup) and sound-profile-builder's
// (free-text agent role names) as of the "product" workload's introduction.
const KNOWN_REVIEW_CALL_TYPES = new Set([
  'legacy',
  'discovery',
  'remediation',
  'deduplicate',
  'feedback_classify',
  'feedback_adjudicate',
  'debug_test_deduplicator',
  'debug_single',
]);

function workloadOf(rec: UsageRecord): 'eval' | 'review' | 'product' {
  if (rec.callType === 'evaluate' || rec.callType.startsWith('llm_compare')) return 'eval';
  if (KNOWN_REVIEW_CALL_TYPES.has(rec.callType)) return 'review';
  return 'product';
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// listUsageRecords reads every record written under usage/<date>/ in
// `bucket` (defaults to this service's own S3_REVIEW_BUCKET). Passing
// tools/eval's bucket (S3_BUCKET, default gsr-eval-results) lets the same
// aggregation logic fold in that service's usage without a cross-project
// import — see workloadOf's comment above.
//
// A record that fails to fetch or decode is skipped with a logged warning
// rather than failing the whole listing — one malformed object shouldn't
// block aggregating everything else that day.
// Bounded-concurrency reads (mirroring ingestUsageRecords's PromisePool
// usage) rather than one getFileStream per file awaited sequentially — a
// heavy-usage day (hundreds+ of individual call records) awaited one at a
// time turns into a multi-second-or-worse fetch, and this path runs
// uncached on every request for "today" (getOrBuildDayRollup never caches
// it), so it's on the hot path for every dashboard load.
const LIST_RECORDS_CONCURRENCY = 20;

export async function listUsageRecords(date: string, bucket: string = getUsageBucketName()): Promise<UsageRecord[]> {
  const files = await listFiles(bucket, `usage/${date}/`);
  const pool = new PromisePool(LIST_RECORDS_CONCURRENCY);
  const results = await Promise.all(files.map(file => pool.add(async (): Promise<UsageRecord | undefined> => {
    try {
      const stream = await getFileStream(bucket, file.name);
      return JSON.parse(await streamToString(stream));
    } catch (err) {
      console.error(`[usage] failed to read/parse ${file.name}:`, err);
      return undefined;
    }
  })));
  return results.filter((r): r is UsageRecord => r !== undefined);
}

// `key` comes from record fields (model/repository/callType, or a
// composite built from them) that ultimately trace back to the
// shared-secret-authenticated ingest path — not fully trusted. `m` is a
// plain object literal, so `m['__proto__']` is a live accessor to the real,
// process-wide Object.prototype: `!m[key]` for that key is falsy (skipping
// the own-property init below) and `b.calls++` would then mutate the actual
// shared prototype, corrupting every plain object in the process. Guard
// against `__proto__`/`constructor`/`prototype` and use hasOwnProperty
// instead of a truthiness check so only genuine own properties count as
// "already initialized".
const UNSAFE_BUCKET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function addToBucket(m: Record<string, UsageBucket>, key: string | undefined, rec: UsageRecord): void {
  if (!key || UNSAFE_BUCKET_KEYS.has(key)) return;
  if (!Object.prototype.hasOwnProperty.call(m, key)) {
    m[key] = { calls: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costUsd: 0 };
  }
  const b = m[key];
  b.calls++;
  if (rec.success) {
    b.successCount++;
  } else {
    b.failureCount++;
  }
  b.inputTokens += rec.inputTokens;
  b.outputTokens += rec.outputTokens;
  b.thinkingTokens += rec.thinkingTokens ?? 0;
  b.costUsd += rec.costUsd;
}

// Unlike addToBucket, `key === '__proto__'` here does NOT actually corrupt
// Object.prototype in practice — verified empirically: reading m['__proto__']
// returns Object.prototype (truthy), the arithmetic coerces it through
// ToPrimitive into a string ("[object Object]1"), and writing that string
// back through the `__proto__` accessor is a silent no-op per spec (it only
// accepts an object or null). The real bug is quieter: the record's error
// silently vanishes from byErrorKind instead of being counted anywhere.
// Guarding explicitly is still worth doing — correctness shouldn't depend on
// an accessor's exact no-op semantics for non-object values — but this is a
// silent-miscount fix, not a prototype-pollution fix like addToBucket's.
function incrementCount(m: Record<string, number>, key: string | undefined, by: number): void {
  if (!key || UNSAFE_BUCKET_KEYS.has(key)) return;
  const current = Object.prototype.hasOwnProperty.call(m, key) ? m[key] : 0;
  m[key] = current + by;
}

// aggregate summarizes records into a Rollup for date. Pure/deterministic —
// no I/O — so it's independently testable from listUsageRecords/writeRollup.
export function aggregate(date: string, records: UsageRecord[]): Rollup {
  const rollup: Rollup = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    date,
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    byCallType: {},
    byModel: {},
    byErrorKind: {},
    byRepository: {},
    byWorkload: {},
    byModelRepository: {},
    byModelWorkload: {},
    byRepositoryWorkload: {},
  };

  for (const rec of records) {
    rollup.totalCalls++;
    if (rec.success) {
      rollup.successCount++;
    } else {
      rollup.failureCount++;
      incrementCount(rollup.byErrorKind, rec.errorKind, 1);
    }
    rollup.totalInputTokens += rec.inputTokens;
    rollup.totalOutputTokens += rec.outputTokens;
    rollup.totalThinkingTokens += rec.thinkingTokens ?? 0;
    rollup.totalCostUsd += rec.costUsd;
    rollup.totalLatencyMs += rec.latencyMs;

    const repository = rec.repository || UNTAGGED_REPOSITORY_LABEL;
    const workload = workloadOf(rec);

    addToBucket(rollup.byCallType, rec.callType, rec);
    addToBucket(rollup.byModel, rec.model, rec);
    addToBucket(rollup.byRepository, repository, rec);
    addToBucket(rollup.byWorkload, workload, rec);
    addToBucket(rollup.byModelRepository, `${rec.model}|${repository}`, rec);
    addToBucket(rollup.byModelWorkload, `${rec.model}|${workload}`, rec);
    addToBucket(rollup.byRepositoryWorkload, `${repository}|${workload}`, rec);
  }

  if (rollup.totalCalls > 0) {
    rollup.avgLatencyMs = rollup.totalLatencyMs / rollup.totalCalls;
  }
  return rollup;
}

// writeRollup persists a Rollup, overwriting any existing rollup for the
// same date — a rollup is a recomputable summary meant to be regenerated
// idempotently, not an append-only log, so an unconditional PUT is correct
// here (unlike per-call records, which are already inherently non-colliding
// thanks to their random-suffixed keys).
export async function writeRollup(rollup: Rollup, bucket: string = getUsageBucketName()): Promise<void> {
  await uploadJson(bucket, `usage/rollups/${rollup.date}.json`, rollup);
}

// currentDateString returns today's YYYY-MM-DD in UTC — split out so tests
// can pass an explicit `today` to getOrBuildDayRollup instead of depending
// on wall-clock time.
export function currentDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function isFreshRollup(value: unknown): value is Rollup {
  return !!value && typeof value === 'object' && (value as Rollup).schemaVersion === CURRENT_SCHEMA_VERSION;
}

// getOrBuildDayRollup is the self-healing cache read the API/CLI should use
// instead of calling aggregate() over listUsageRecords() directly:
// - `date >= today` (today itself, or a future date — the API route doesn't
//   reject a `to` beyond today): always recomputed from raw records, never
//   cached. Today's data is still accumulating; a future date would
//   otherwise get a permanently-cached EMPTY rollup that then masks real
//   data once that date actually arrives — caching must be strictly bounded
//   to the immutable past.
// - any date before today: served from usage/rollups/<date>.json when
//   present and at CURRENT_SCHEMA_VERSION; otherwise (missing, unparsable,
//   or written by an out-of-sync producer — an older deploy, or
//   usage-report.js's own hand-copied aggregate() before it's updated to
//   match) recomputed and the cache overwritten, so a stale shape self-heals
//   on first read rather than requiring a manual re-run.
//
// `bucket` defaults to this service's own S3_REVIEW_BUCKET; the usage-
// summary route (app.ts) also calls this with tools/eval's bucket
// (S3_BUCKET, default gsr-eval-results) to build its "eval-harness" source
// view — see workloadOf's comment for why that's a bucket parameter here
// rather than a cross-project import.
export async function getOrBuildDayRollup(date: string, today: string = currentDateString(), bucket: string = getUsageBucketName()): Promise<Rollup> {
  const isPast = date < today;
  if (isPast) {
    const cached = await getFileJson(bucket, `usage/rollups/${date}.json`);
    if (isFreshRollup(cached)) {
      return cached;
    }
  }

  const rollup = aggregate(date, await listUsageRecords(date, bucket));
  if (isPast) {
    await writeRollup(rollup, bucket);
  }
  return rollup;
}

// Mutates and returns `a` — safe because every call site passes its own
// private accumulator (built fresh inside sumRollups, never aliased
// elsewhere before the function returns), so there's no risk of mutating
// something a caller still holds a reference to. Iterating only `b`'s keys
// (rather than the union of both) and updating `a` directly avoids
// reallocating a whole new object on every merge.
function mergeBucketMaps(a: Record<string, UsageBucket>, b: Record<string, UsageBucket>): Record<string, UsageBucket> {
  for (const key of Object.keys(b)) {
    const y = b[key];
    if (!Object.prototype.hasOwnProperty.call(a, key)) {
      a[key] = { ...y };
      continue;
    }
    const x = a[key];
    x.calls += y.calls;
    x.successCount += y.successCount;
    x.failureCount += y.failureCount;
    x.inputTokens += y.inputTokens;
    x.outputTokens += y.outputTokens;
    x.thinkingTokens += y.thinkingTokens;
    x.costUsd += y.costUsd;
  }
  return a;
}

// sumRollups folds several day-rollups (or a backend rollup + a tools/eval
// rollup, since both share this exact shape) into one, labeled `label`
// (e.g. a week/month/range identifier, not necessarily a single date).
// Every Rollup/UsageBucket field is additive except avgLatencyMs, which is
// re-derived from the summed totalLatencyMs/totalCalls rather than averaged
// a second time.
export function sumRollups(label: string, rollups: Rollup[]): Rollup {
  const result: Rollup = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    date: label,
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    byCallType: {},
    byModel: {},
    byErrorKind: {},
    byRepository: {},
    byWorkload: {},
    byModelRepository: {},
    byModelWorkload: {},
    byRepositoryWorkload: {},
  };

  for (const r of rollups) {
    result.totalCalls += r.totalCalls;
    result.successCount += r.successCount;
    result.failureCount += r.failureCount;
    result.totalInputTokens += r.totalInputTokens;
    result.totalOutputTokens += r.totalOutputTokens;
    result.totalThinkingTokens += r.totalThinkingTokens;
    result.totalCostUsd += r.totalCostUsd;
    result.totalLatencyMs += r.totalLatencyMs;
    for (const kind of Object.keys(r.byErrorKind)) {
      incrementCount(result.byErrorKind, kind, r.byErrorKind[kind]);
    }
    result.byCallType = mergeBucketMaps(result.byCallType, r.byCallType);
    result.byModel = mergeBucketMaps(result.byModel, r.byModel);
    result.byRepository = mergeBucketMaps(result.byRepository, r.byRepository);
    result.byWorkload = mergeBucketMaps(result.byWorkload, r.byWorkload);
    result.byModelRepository = mergeBucketMaps(result.byModelRepository, r.byModelRepository);
    result.byModelWorkload = mergeBucketMaps(result.byModelWorkload, r.byModelWorkload);
    result.byRepositoryWorkload = mergeBucketMaps(result.byRepositoryWorkload, r.byRepositoryWorkload);
  }

  if (result.totalCalls > 0) {
    result.avgLatencyMs = result.totalLatencyMs / result.totalCalls;
  }
  return result;
}

// --- Ingest from remote GSR Action runs ---

const MAX_REPOSITORY_LABEL_LENGTH = 200;

// Callers only need to hold USAGE_INGEST_SHARED_SECRET to reach this path
// (see app.ts), so a record's shape can't be trusted the way an in-process
// trackGeminiCall() call can — reject anything that doesn't look like a
// real UsageRecord instead of writing it verbatim, which would otherwise
// silently corrupt a later aggregate() rollup with malformed/adversarial
// values. In particular, `model`/`repository` must not contain the `|`
// composite-key delimiter aggregate()'s byModelRepository/byModelWorkload/
// byRepositoryWorkload maps rely on being absent (see the comment above the
// Rollup interface) — an ingested value that violated that would silently
// misattribute columns in every consumer that splits a key on `|`,
// including the dashboard frontend.
function isValidIngestedRecordShape(record: unknown): record is UsageRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.callType === 'string' &&
    typeof r.model === 'string' && !r.model.includes('|') &&
    typeof r.inputTokens === 'number' && Number.isFinite(r.inputTokens) && r.inputTokens >= 0 &&
    typeof r.outputTokens === 'number' && Number.isFinite(r.outputTokens) && r.outputTokens >= 0 &&
    typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) && r.latencyMs >= 0 &&
    typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0 &&
    typeof r.success === 'boolean' &&
    typeof r.timestamp === 'string' &&
    r.provider === 'gemini' &&
    (r.thinkingTokens === undefined || (typeof r.thinkingTokens === 'number' && Number.isFinite(r.thinkingTokens) && r.thinkingTokens >= 0)) &&
    (r.repository === undefined || (typeof r.repository === 'string' && !r.repository.includes('|'))) &&
    (r.cachedTokens === undefined || (typeof r.cachedTokens === 'number' && Number.isFinite(r.cachedTokens) && r.cachedTokens >= 0)) &&
    // errorKind flows into byErrorKind[key] unguarded by addToBucket's
    // UNSAFE_BUCKET_KEYS check (that's for the UsageBucket maps only) — the
    // aggregate()/sumRollups() incrementCount() helper is the actual
    // backstop, but reject it here too as defense-in-depth so a malformed
    // record never lands in storage in the first place.
    (r.errorKind === undefined || (typeof r.errorKind === 'string' && !UNSAFE_BUCKET_KEYS.has(r.errorKind)))
  );
}

// ingestUsageRecords persists records reported by a remote GSR Action run
// (see adk/backend/src/usageReporter.ts and the POST /api/usage/ingest
// route in app.ts). Deliberately bypasses the sink override above and
// writes straight to storage: ingested records already carry a real
// client-side timestamp from when the Gemini call actually happened
// (possibly minutes before the batch is POSTed), and this path must always
// land in real storage regardless of any setUsageSink() call elsewhere in
// the process. Writes under the same usage/<date>/... prefix as native
// records — tagged with `repository` when known — so listUsageRecords/
// aggregate/writeRollup fold Action-reported usage into existing rollups
// without any changes.
const INGEST_CONCURRENCY = 10;

export async function ingestUsageRecords(
  records: UsageRecord[],
  opts?: { repository?: string }
): Promise<{ accepted: number; failed: number }> {
  const rawRepository = opts?.repository?.slice(0, MAX_REPOSITORY_LABEL_LENGTH);
  // Drop rather than reject the whole batch over a bad batch-level label —
  // same "|" composite-key concern as isValidIngestedRecordShape above.
  const repository = rawRepository && !rawRepository.includes('|') ? rawRepository : undefined;

  // Bounded-concurrency writes (mirroring Orchestrator's own PromisePool
  // usage) rather than one uploadJson per record awaited sequentially — a
  // full MAX_USAGE_INGEST_RECORDS batch awaited one-at-a-time can easily
  // outlast the caller's own request timeout (see usageReporter.ts) even
  // though every write eventually succeeds.
  const pool = new PromisePool(INGEST_CONCURRENCY);
  const outcomes = await Promise.all(records.map(record => pool.add(async (): Promise<boolean> => {
    if (!isValidIngestedRecordShape(record)) {
      console.error('[usage] rejected a malformed ingested usage record');
      return false;
    }
    try {
      const tagged: UsageRecord = repository ? { ...record, repository } : record;
      // Key the object by the record's OWN timestamp, not the moment it
      // happens to be ingested — a batch can be POSTed minutes (a live
      // reporter) or, for a backfill, months after the calls it describes
      // actually happened. Keying by `new Date()` here would silently land
      // every ingested record under today's prefix regardless of when the
      // underlying Gemini call ran, which would have made a historical
      // backfill land entirely on the day it was run instead of the dates
      // it's restoring (the same bug class already fixed in tools/eval's
      // local writer). Fall back to `new Date()` only if the reported
      // timestamp doesn't parse, so a malformed record still lands somewhere
      // findable instead of being silently dropped.
      const parsed = new Date(tagged.timestamp);
      const recordDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      if (Number.isNaN(parsed.getTime())) {
        console.warn('[usage] ingested record has an unparsable timestamp; filing under today instead:', tagged.timestamp);
      }
      await uploadJson(getUsageBucketName(), objectKey(recordDate), tagged);
      return true;
    } catch (err) {
      console.error('[usage] failed to ingest a reported usage record:', err);
      return false;
    }
  })));

  const accepted = outcomes.filter(Boolean).length;
  return { accepted, failed: outcomes.length - accepted };
}

// --- Job-summary formatting for GitHub Action runs ---

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

// formatUsageSummaryMarkdown renders a Rollup as GitHub-Flavored Markdown
// for $GITHUB_STEP_SUMMARY. Pure — independently testable from the
// file-writing side, which lives in action-entrypoint.ts.
export function formatUsageSummaryMarkdown(rollup: Rollup): string {
  const lines: string[] = [];
  lines.push('## GSR Usage Summary');
  lines.push('');
  lines.push('| Calls | Success | Failed | Input tokens | Output tokens | Cost | Avg latency |');
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(
    `| ${rollup.totalCalls} | ${rollup.successCount} | ${rollup.failureCount} | ` +
    `${rollup.totalInputTokens} | ${rollup.totalOutputTokens} | ${formatUsd(rollup.totalCostUsd)} | ` +
    `${Math.round(rollup.avgLatencyMs)}ms |`
  );

  const callTypes = Object.keys(rollup.byCallType);
  if (callTypes.length > 0) {
    lines.push('');
    lines.push('### By call type');
    lines.push('');
    lines.push('| Call type | Calls | Input tokens | Output tokens | Cost |');
    lines.push('|---|---|---|---|---|');
    for (const callType of callTypes) {
      const b = rollup.byCallType[callType];
      lines.push(`| ${callType} | ${b.calls} | ${b.inputTokens} | ${b.outputTokens} | ${formatUsd(b.costUsd)} |`);
    }
  }

  const errorKinds = Object.keys(rollup.byErrorKind);
  if (errorKinds.length > 0) {
    lines.push('');
    lines.push('### Errors');
    lines.push('');
    lines.push('| Error kind | Count |');
    lines.push('|---|---|');
    for (const kind of errorKinds) {
      lines.push(`| ${kind} | ${rollup.byErrorKind[kind]} |`);
    }
  }

  return lines.join('\n');
}
