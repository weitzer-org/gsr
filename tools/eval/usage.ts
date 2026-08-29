// Persists per-Gemini-call token/latency/cost/success records for
// tools/eval's own judge calls (llm-comparator.ts / llm-comparator-v2.ts),
// to this service's own bucket (S3_BUCKET, default gsr-eval-results) — a
// deliberate, separate copy of adk/backend/src/usage.ts's write-path shapes
// and logic rather than a shared import, since tools/eval is a genuinely
// separate deployable with its own storage.ts (same convention already
// established: usage-report.js at the repo root keeps its own hand-copied
// `aggregate()` in sync with adk/backend's for the same reason).
//
// This module deliberately only owns the WRITE path. Reading/aggregating
// this bucket for the usage dashboard is done by adk/backend/src/usage.ts's
// own listUsageRecords/getOrBuildDayRollup, parameterized with this
// service's bucket name — that avoids a cross-directory TypeScript import
// between two independently-built projects (adk/backend's tsconfig has
// `rootDir: "."`, which rejects sources outside adk/backend at build time),
// and it means there's exactly one aggregate()/Rollup implementation to
// keep correct, not two.
//
// Every record here is tagged `repository: 'tools-eval (local)'` up front so
// it lands in its own bucket of adk/backend's "consuming project" breakdown
// without either side needing special-case logic, and `callType` values all
// start with `llm_compare` so adk/backend's workload split (see usage.ts's
// workloadOf()) buckets them under "eval" alongside its own `evaluate`
// callType.
import { uploadResultsToGCS } from './storage';

const REPOSITORY_LABEL = 'tools-eval (local)';

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

// thinkingTokens billed at the output rate — same unverified assumption as
// adk/backend/src/usage.ts's computeCostUsd; re-check before relying on
// this for real cost reporting.
export function computeCostUsd(model: string, inputTokens: number, outputTokens: number, cachedTokens = 0, thinkingTokens = 0): number {
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const perM = 1_000_000;
  const billedInput = Math.max(0, inputTokens - cachedTokens);
  return (billedInput * price.input) / perM + ((outputTokens + thinkingTokens) * price.output) / perM;
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
  const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  return `usage/${day}/${time}-${rand}.json`;
}

// recordUsage never throws — a broken/unreachable write must never fail an
// eval run just because its analytics couldn't be recorded.
export async function recordUsage(event: UsageEvent): Promise<void> {
  const record: UsageRecord = { ...event, provider: 'gemini', repository: REPOSITORY_LABEL, timestamp: new Date().toISOString() };
  try {
    await uploadResultsToGCS(getUsageBucketName(), objectKey(new Date()), record);
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
      costUsd: computeCostUsd(ctx.model, inputTokens, outputTokens, cachedTokens, thinkingTokens),
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
