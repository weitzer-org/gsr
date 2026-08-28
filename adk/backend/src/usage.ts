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
import { uploadJson, listFiles, getFileStream } from './storage';
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
};

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
  };
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
    await recordUsage({
      callType: ctx.callType,
      refId: ctx.refId,
      model: ctx.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      latencyMs,
      costUsd: computeCostUsd(ctx.model, inputTokens, outputTokens, cachedTokens),
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

// --- Rollup aggregation, mirroring internal/usage's Aggregate/ListRecords
// in the sibling job_tracker project. ---

export interface UsageBucket {
  calls: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Rollup {
  date: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  byCallType: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  byErrorKind: Record<string, number>;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// listUsageRecords reads every record written under usage/<date>/. A record
// that fails to fetch or decode is skipped with a logged warning rather than
// failing the whole listing — one malformed object shouldn't block
// aggregating everything else that day.
export async function listUsageRecords(date: string): Promise<UsageRecord[]> {
  const bucket = getUsageBucketName();
  const files = await listFiles(bucket, `usage/${date}/`);
  const records: UsageRecord[] = [];
  for (const file of files) {
    try {
      const stream = await getFileStream(bucket, file.name);
      records.push(JSON.parse(await streamToString(stream)));
    } catch (err) {
      console.error(`[usage] failed to read/parse ${file.name}:`, err);
    }
  }
  return records;
}

function addToBucket(m: Record<string, UsageBucket>, key: string | undefined, rec: UsageRecord): void {
  if (!key) return;
  if (!m[key]) {
    m[key] = { calls: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
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
  b.costUsd += rec.costUsd;
}

// aggregate summarizes records into a Rollup for date. Pure/deterministic —
// no I/O — so it's independently testable from listUsageRecords/writeRollup.
export function aggregate(date: string, records: UsageRecord[]): Rollup {
  const rollup: Rollup = {
    date,
    totalCalls: 0,
    successCount: 0,
    failureCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    avgLatencyMs: 0,
    byCallType: {},
    byModel: {},
    byErrorKind: {},
  };

  let totalLatencyMs = 0;
  for (const rec of records) {
    rollup.totalCalls++;
    if (rec.success) {
      rollup.successCount++;
    } else {
      rollup.failureCount++;
      if (rec.errorKind) {
        rollup.byErrorKind[rec.errorKind] = (rollup.byErrorKind[rec.errorKind] || 0) + 1;
      }
    }
    rollup.totalInputTokens += rec.inputTokens;
    rollup.totalOutputTokens += rec.outputTokens;
    rollup.totalCostUsd += rec.costUsd;
    totalLatencyMs += rec.latencyMs;

    addToBucket(rollup.byCallType, rec.callType, rec);
    addToBucket(rollup.byModel, rec.model, rec);
  }

  if (rollup.totalCalls > 0) {
    rollup.avgLatencyMs = totalLatencyMs / rollup.totalCalls;
  }
  return rollup;
}

// writeRollup persists a Rollup, overwriting any existing rollup for the
// same date — a rollup is a recomputable summary meant to be regenerated
// idempotently, not an append-only log, so an unconditional PUT is correct
// here (unlike per-call records, which are already inherently non-colliding
// thanks to their random-suffixed keys).
export async function writeRollup(rollup: Rollup): Promise<void> {
  await uploadJson(getUsageBucketName(), `usage/rollups/${rollup.date}.json`, rollup);
}

// --- Ingest from remote GSR Action runs ---

const MAX_REPOSITORY_LABEL_LENGTH = 200;

// Callers only need to hold USAGE_INGEST_SHARED_SECRET to reach this path
// (see app.ts), so a record's shape can't be trusted the way an in-process
// trackGeminiCall() call can — reject anything that doesn't look like a
// real UsageRecord instead of writing it verbatim, which would otherwise
// silently corrupt a later aggregate() rollup with malformed/adversarial
// values.
function isValidIngestedRecordShape(record: unknown): record is UsageRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.callType === 'string' &&
    typeof r.model === 'string' &&
    typeof r.inputTokens === 'number' && Number.isFinite(r.inputTokens) &&
    typeof r.outputTokens === 'number' && Number.isFinite(r.outputTokens) &&
    typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) &&
    typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) &&
    typeof r.success === 'boolean' &&
    typeof r.timestamp === 'string' &&
    r.provider === 'gemini'
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
  const repository = opts?.repository?.slice(0, MAX_REPOSITORY_LABEL_LENGTH);

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
      await uploadJson(getUsageBucketName(), objectKey(new Date()), tagged);
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
