// Finding feedback storage (finding-feedback-requirements.md §5, §7). Phase 3
// of pr-comment-feedback-loop-design.md — "the right sink" for that feature's
// export, but written to serve any producer of the FindingFeedback shape
// (§2's primary use case is an external coding agent, not just this repo's
// own PR-comment loop). Same S3-compatible layer as everything else
// (storage.ts's uploadJson/listFiles/getFileStream), a dedicated bucket
// rather than a prefix (§7: keeps future lifecycle/retention/IAM policy
// independent of review-result data).
import { randomBytes } from 'crypto';
import { uploadJson, listFiles, getFileStream, StoredFile } from './storage';
import { FindingFeedback, FeedbackVerdict, AdjudicationVerdict } from './types';
import { PromisePool } from './pool';
import type { Readable } from 'stream';

function getFeedbackBucketName(): string {
  return process.env.S3_FEEDBACK_BUCKET || 'gsr-review-feedback';
}

// Size caps (§5.4) — bound abuse on a publicly-reachable write endpoint
// (§8) as much as they bound noise in the eventual prompt-tuning dataset
// (§9.1). The overall-request-body cap lives at the route's express.json()
// limit (app.ts), not here.
const MAX_SHORT_FIELD_LEN = 2000;   // findingId/file/severity/agent/summary/reviewUrl/promptVersion/submittedBy/threadUrl
const MAX_COMMENT_LEN = 4000;       // ~4KB
const MAX_CODE_FEEDBACK_LEN = 4000; // ~4KB
const MAX_CODE_LEN = 32000;         // ~32KB
const MAX_REASONING_LEN = 4000;     // adjudication.reasoning — same order as comment
// Exported so feedbackReporter.ts's client-side default batch size can stay
// in sync with this server-side cap instead of drifting independently.
export const MAX_BATCH_ITEMS = 50;

const VALID_VERDICTS = new Set<FeedbackVerdict>(['valid', 'invalid', 'partial']);
const VALID_SOURCES = new Set(['agent-push', 'pr-thread']);
const VALID_STANCES = new Set(['accepted', 'rejected', 'question', 'neutral']);
const VALID_ADJUDICATION_VERDICTS = new Set(['pushback_correct', 'pushback_incorrect', 'unclear']);

function isBoundedString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

// Self-review finding: `v == null` (loose equality) covers both `undefined`
// (the field omitted) and `null` (a common way JSON-serializing clients
// represent an absent optional field explicitly) — a strict `v === undefined`
// check would reject an otherwise-valid submission just for spelling
// "absent" as `null` instead of leaving the key out.
function isBoundedOptionalString(v: unknown, maxLen: number): v is string | undefined | null {
  return v == null || (typeof v === 'string' && v.length <= maxLen);
}

// validateFeedbackItem rejects anything that doesn't look like a real
// FindingFeedback submission instead of writing it verbatim — the caller
// only needs to hold FEEDBACK_SHARED_SECRET (or a session cookie) to reach
// this path, so a record's shape can't be trusted the way an in-process
// caller's could be (same reasoning as usage.ts's isValidIngestedRecordShape,
// but with actual content validation since this endpoint is a general-purpose
// write surface, not internal telemetry).
export function validateFeedbackItem(raw: unknown, defaultReviewUrl?: string): { ok: true; value: Omit<FindingFeedback, 'submittedAt'> } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'item must be an object' };
  const r = raw as Record<string, unknown>;

  if (!isBoundedString(r.findingId, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'findingId is required' };
  if (!isBoundedString(r.file, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'file is required' };
  if (typeof r.line !== 'number' || !Number.isFinite(r.line)) return { ok: false, error: 'line must be a number' };
  if (!isBoundedString(r.severity, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'severity is required' };
  if (!isBoundedString(r.agent, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'agent is required' };
  if (!isBoundedString(r.summary, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'summary is required' };

  const reviewUrl = typeof r.reviewUrl === 'string' && r.reviewUrl ? r.reviewUrl : defaultReviewUrl;
  if (!isBoundedString(reviewUrl, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'reviewUrl is required (on the item, or the batch wrapper)' };

  if (!isBoundedOptionalString(r.promptVersion, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'promptVersion too long' };

  if (typeof r.verdict !== 'string' || !VALID_VERDICTS.has(r.verdict as FeedbackVerdict)) {
    return { ok: false, error: 'verdict must be one of "valid", "invalid", "partial"' };
  }
  if (!isBoundedString(r.comment, MAX_COMMENT_LEN)) return { ok: false, error: 'comment is required (and must be under 4KB)' };

  if (!isBoundedOptionalString(r.exampleCodeBefore, MAX_CODE_LEN)) return { ok: false, error: 'exampleCodeBefore too long (max 32KB)' };
  if (!isBoundedOptionalString(r.exampleCodeAfter, MAX_CODE_LEN)) return { ok: false, error: 'exampleCodeAfter too long (max 32KB)' };
  if (!isBoundedOptionalString(r.codeFeedback, MAX_CODE_FEEDBACK_LEN)) return { ok: false, error: 'codeFeedback too long (max 4KB)' };

  if (!isBoundedString(r.submittedBy, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'submittedBy is required' };

  if (r.source !== undefined && (typeof r.source !== 'string' || !VALID_SOURCES.has(r.source))) {
    return { ok: false, error: 'source must be "agent-push" or "pr-thread"' };
  }
  if (!isBoundedOptionalString(r.threadUrl, MAX_SHORT_FIELD_LEN)) return { ok: false, error: 'threadUrl too long' };
  if (r.stance !== undefined && (typeof r.stance !== 'string' || !VALID_STANCES.has(r.stance))) {
    return { ok: false, error: 'stance must be one of "accepted", "rejected", "question", "neutral"' };
  }

  let adjudication: FindingFeedback['adjudication'];
  if (r.adjudication !== undefined) {
    if (!r.adjudication || typeof r.adjudication !== 'object') return { ok: false, error: 'adjudication must be an object' };
    const a = r.adjudication as Record<string, unknown>;
    if (typeof a.verdict !== 'string' || !VALID_ADJUDICATION_VERDICTS.has(a.verdict)) {
      return { ok: false, error: 'adjudication.verdict must be one of "pushback_correct", "pushback_incorrect", "unclear"' };
    }
    if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence)) return { ok: false, error: 'adjudication.confidence must be a number' };
    if (!isBoundedString(a.reasoning, MAX_REASONING_LEN)) return { ok: false, error: 'adjudication.reasoning is required (and must be under 4KB)' };
    adjudication = {
      verdict: a.verdict as AdjudicationVerdict,
      confidence: Math.max(0, Math.min(1, a.confidence)),
      reasoning: a.reasoning,
    };
  }

  return {
    ok: true,
    value: {
      findingId: r.findingId as string,
      file: r.file as string,
      line: r.line as number,
      severity: r.severity as string,
      agent: r.agent as string,
      summary: r.summary as string,
      reviewUrl: reviewUrl as string,
      // Normalized (not just cast) — isBoundedOptionalString accepts an
      // explicit `null` as equivalent to "absent," so a caller-sent `null`
      // must become `undefined` here rather than being carried through as a
      // literal `null` mistyped as `string | undefined`.
      promptVersion: (r.promptVersion ?? undefined) as string | undefined,
      verdict: r.verdict as FeedbackVerdict,
      comment: r.comment as string,
      exampleCodeBefore: (r.exampleCodeBefore ?? undefined) as string | undefined,
      exampleCodeAfter: (r.exampleCodeAfter ?? undefined) as string | undefined,
      codeFeedback: (r.codeFeedback ?? undefined) as string | undefined,
      submittedBy: r.submittedBy as string,
      source: r.source as FindingFeedback['source'],
      threadUrl: (r.threadUrl ?? undefined) as string | undefined,
      stance: r.stance as FindingFeedback['stance'],
      adjudication,
    },
  };
}

// safeUrlSegment mirrors app.ts's review-run key convention
// (url.replace(/[^a-zA-Z0-9]/g, '-')), plus a length cap: `reviewUrl` and
// `findingId` are both externally-supplied on this general-purpose endpoint
// (unlike the PR-comment loop's own 16-hex-char findingId scheme, an
// arbitrary consumer can send up to MAX_SHORT_FIELD_LEN of either) and S3
// hard-limits an object key to 1024 bytes — two ~2KB fields concatenated into
// one key would exceed that and fail the PutObjectCommand outright.
// Self-review finding: this must ALSO apply to `findingId`, not just
// `reviewUrl` — findingId was previously interpolated into the key raw, with
// no character sanitization (a `/`, control character, or overlong value
// could produce a malformed or oversized key) and no length bound of its
// own. The stored record still keeps the full, untruncated values (this
// only shortens what's used to build the key, not what's persisted).
const MAX_KEY_SEGMENT_LEN = 80;
function safeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-').slice(0, MAX_KEY_SEGMENT_LEN);
}

// objectKey follows §7's `feedback_<ISO>_<safe-review-url>_<findingId>.json`
// convention, with a short random suffix appended — §7 documents duplicate/
// retry submissions as intentionally accepted as separate log entries rather
// than deduped, which an unconditional PUT on the literal key alone couldn't
// guarantee if two records for the same finding land in the same request
// (same server-assigned submittedAt down to the millisecond): the second
// would silently overwrite the first instead of becoming its own entry.
function objectKey(record: FindingFeedback): string {
  const day = record.submittedAt.replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  return `feedback_${day}_${safeKeySegment(record.reviewUrl)}_${safeKeySegment(record.findingId)}_${rand}.json`;
}

async function writeFeedbackRecord(record: FindingFeedback): Promise<void> {
  await uploadJson(getFeedbackBucketName(), objectKey(record), record);
}

export interface IngestFeedbackResult {
  accepted: number;
  rejected: number;
  errors: string[];
}

// INGEST_CONCURRENCY mirrors usage.ts's ingestUsageRecords exactly — bounded-
// concurrency writes rather than one uploadJson per record awaited
// sequentially. Self-review finding: a batch of up to MAX_BATCH_ITEMS
// sequential S3 PUTs is a real N+1 latency bottleneck (each an independent
// network round-trip), unnecessary here since every item is independent —
// no ordering or shared-state dependency between them.
const INGEST_CONCURRENCY = 10;

// ingestFeedbackBody accepts either a single FindingFeedback object or
// `{ reviewUrl, items: FindingFeedback[] }` for a batch (§5.4) — a coding
// agent fixing several flagged issues in one PR session has feedback on
// multiple findings at once, and this avoids N auth round-trips for N
// findings. Each item is validated independently; one malformed item in a
// batch doesn't reject the whole batch (same "isolate the failure" pattern
// as usage.ts's ingestUsageRecords). Validation (synchronous, no I/O) runs
// sequentially over all items first; only the actual writes are pooled.
export async function ingestFeedbackBody(body: unknown): Promise<IngestFeedbackResult | { error: string }> {
  if (!body || typeof body !== 'object') return { error: 'request body must be an object' };
  const b = body as Record<string, unknown>;

  const isBatch = Array.isArray(b.items);
  const rawItems: unknown[] = isBatch ? (b.items as unknown[]) : [body];
  const batchReviewUrl = typeof b.reviewUrl === 'string' ? b.reviewUrl : undefined;

  if (rawItems.length === 0) return { error: '"items" must be a non-empty array' };
  if (rawItems.length > MAX_BATCH_ITEMS) return { error: `too many items (max ${MAX_BATCH_ITEMS} per request)` };

  const submittedAt = new Date().toISOString();
  const errors: string[] = [];
  const validItems: Omit<FindingFeedback, 'submittedAt'>[] = [];
  for (const rawItem of rawItems) {
    const result = validateFeedbackItem(rawItem, batchReviewUrl);
    if (result.ok) {
      validItems.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  const pool = new PromisePool(INGEST_CONCURRENCY);
  let accepted = 0;
  await Promise.all(validItems.map(value => pool.add(async () => {
    try {
      await writeFeedbackRecord({ ...value, submittedAt });
      accepted++;
    } catch (err) {
      console.error('[feedback] failed to write a feedback record:', err);
      errors.push('storage write failed');
    }
  })));

  return { accepted, rejected: rawItems.length - accepted, errors };
}

export async function listFeedbackFiles(): Promise<StoredFile[]> {
  return listFiles(getFeedbackBucketName(), 'feedback_', { maxResults: 100 });
}

export async function getFeedbackRecordStream(id: string): Promise<Readable> {
  return getFileStream(getFeedbackBucketName(), id);
}
