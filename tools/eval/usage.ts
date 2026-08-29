// Persists per-Gemini-call token/latency/cost/success records for
// tools/eval's own judge calls (llm-comparator.ts / llm-comparator-v2.ts) —
// both to this service's own bucket (S3_BUCKET, default gsr-eval-results,
// a deliberate separate copy of adk/backend/src/usage.ts's write-path
// shapes and logic rather than a shared import, matching the existing
// usage-report.js convention) AND, unconditionally, to the hosted
// production dashboard via POST /api/usage/ingest — reusing
// adk/backend/src/usageReporter.ts's reportUsage() rather than writing a
// second HTTP client. tools/eval already imports adk/backend code in this
// direction (evaluate.ts imports ./github), so this isn't a new pattern;
// it's the *other* cross-directory import direction (adk/backend importing
// from tools/eval) that's off-limits, since adk/backend's tsconfig has
// `rootDir: "."`.
//
// Deliberately does NOT gate this on whether a shared secret happens to be
// configured — every local run's usage is meant to show up in the
// production dashboard, the same way a GitHub Action's reported usage does,
// just without needing storage write credentials on every laptop.
// recordUsage() still never throws either way: a missing/invalid secret or
// an unreachable backend logs a warning (via reportUsage's own handling)
// but must never fail the eval run itself.
//
// This module deliberately only owns the WRITE path. Reading/aggregating
// the *local* bucket for the local dev dashboard is done by
// adk/backend/src/usage.ts's own listUsageRecords/getOrBuildDayRollup,
// parameterized with this service's bucket name — that's a second,
// unrelated reason the read side isn't duplicated here: it means there's
// exactly one aggregate()/Rollup implementation to keep correct, not two.
//
// Every record here is tagged `repository: 'tools-eval (local)'` up front so
// it lands in its own bucket of adk/backend's "consuming project" breakdown
// without either side needing special-case logic, and `callType` values all
// start with `llm_compare` so adk/backend's workload split (see usage.ts's
// workloadOf()) buckets them under "eval" alongside its own `evaluate`
// callType.
import { randomBytes } from 'crypto';
import { uploadResultsToGCS } from './storage';
import { reportUsage } from '../../adk/backend/src/usageReporter';

const REPOSITORY_LABEL = 'tools-eval (local)';

// The hosted backend's ingest endpoint — overridable (e.g. for a staging
// deploy) via USAGE_INGEST_URL, but reporting itself isn't optional; only
// the destination is.
const DEFAULT_USAGE_INGEST_URL = 'https://gsr-code-review.fly.dev/api/usage/ingest';

// Logged at most once per process — every recordUsage() call would
// otherwise repeat the same warning for every Gemini call in a run.
let warnedMissingIngestKey = false;

export interface UsageEvent {
  callType: string; // "llm_compare"/"llm_compare_aggregate" (llm-comparator.ts),
                     // "llm_compare_v2"/"llm_compare_v2_aggregate" (llm-comparator-v2.ts)
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  thinkingTokens?: number;
  latencyMs: number;
  costUsd: number;
  success: boolean;
  errorKind?: string;
}

export interface UsageRecord extends UsageEvent {
  timestamp: string; // ISO 8601, UTC
  provider: 'gemini';
  repository: string;
}

// USD per 1,000,000 tokens. Keep in sync with adk/backend/src/usage.ts's
// PRICE_TABLE (and, transitively, job_tracker's internal/scoring/
// pricing.go) — three copies now, all mirroring the same Gemini pricing.
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'gemini-2.5-pro': { input: 1.25, output: 10.0 }, // <=200k-token-prompt tier — verify against current pricing if usage grows large
};

// thinkingTokens is NOT added to outputTokens — same reasoning as
// adk/backend/src/usage.ts's computeCostUsd: Gemini's pricing page describes
// the output rate as already "including thinking tokens", so adding them on
// top risks double-billing. Tracked as observability only.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0): number {
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const perM = 1_000_000;
  const billedInput = Math.max(0, inputTokens - cachedTokens);
  return (billedInput * price.input) / perM + (outputTokens * price.output) / perM;
}

// classifyError mirrors adk/backend/src/usage.ts's version.
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
  return process.env.S3_BUCKET || 'gsr-eval-results';
}

function objectKey(date: Date): string {
  const iso = date.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 23).replace(/[:.]/g, '');
  const rand = randomBytes(4).toString('hex');
  return `usage/${day}/${time}-${rand}.json`;
}

async function writeLocal(record: UsageRecord): Promise<void> {
  try {
    await uploadResultsToGCS(getUsageBucketName(), objectKey(new Date()), record);
  } catch (err) {
    console.error('[usage] failed to record usage event locally:', err);
  }
}

async function reportToProduction(record: UsageRecord): Promise<void> {
  const key = process.env.USAGE_INGEST_SHARED_SECRET;
  if (!key) {
    if (!warnedMissingIngestKey) {
      console.warn('[usage] USAGE_INGEST_SHARED_SECRET is not set — this run\'s usage will not be reported to the production dashboard (recorded locally only).');
      warnedMissingIngestKey = true;
    }
    return;
  }

  // reportUsage's own contract is "never throws" (it catches per-batch
  // internally), but recordUsage's callers rely on that same guarantee
  // transitively — don't let a future change to that contract silently
  // break it here too.
  try {
    const url = process.env.USAGE_INGEST_URL || DEFAULT_USAGE_INGEST_URL;
    await reportUsage([record], { url, key, repository: REPOSITORY_LABEL });
  } catch (err) {
    console.error('[usage] failed to report usage event to production:', err);
  }
}

// recordUsage never throws — a broken/unreachable write (local or remote)
// must never fail an eval run just because its analytics couldn't be
// recorded. The two writes are independent and both always attempted, and
// run CONCURRENTLY rather than one after the other: trackGeminiCall awaits
// this before returning the tracked call's response to its own caller, so a
// slow/unreachable production endpoint (reportUsage's own timeout is 10s)
// stacked in series after the local write would otherwise add real,
// avoidable wall-clock latency to every judge call in a run.
export async function recordUsage(event: UsageEvent): Promise<void> {
  const record: UsageRecord = { ...event, provider: 'gemini', repository: REPOSITORY_LABEL, timestamp: new Date().toISOString() };
  await Promise.all([writeLocal(record), reportToProduction(record)]);
}

type GenerateContentLikeResponse = {
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
};

// trackGeminiCall wraps a single `ai.models.generateContent(...)` call — see
// llm-comparator.ts/llm-comparator-v2.ts. Mirrors adk/backend/src/usage.ts's
// version: records success or failure, never changes the call's outcome.
export async function trackGeminiCall<T extends GenerateContentLikeResponse>(
  ctx: { callType: string; model: string },
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
      model: ctx.model,
      inputTokens,
      outputTokens,
      cachedTokens,
      thinkingTokens,
      latencyMs,
      costUsd: computeCostUsd(ctx.model, inputTokens, outputTokens, cachedTokens),
      success: true,
    });
    return response;
  } catch (err) {
    const latencyMs = Date.now() - start;
    await recordUsage({
      callType: ctx.callType,
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
