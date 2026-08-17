// Stage 3 ("report") of the PR comment feedback loop — a near-clone of
// usageReporter.ts's transport (design doc §6.2, §11.2): fire-and-forget,
// batched POSTs from the Action to a hosted GSR endpoint, opt-in and off by
// default, never throws. Deliberately transport-only — the domain mapping
// from a FeedbackPassResult to FindingFeedback records lives in
// feedbackLoop.ts's buildFeedbackRecords, which this module doesn't know
// about; action-entrypoint.ts wires the two together.
import { FindingFeedback } from './types';
import { chunkRecords } from './usageReporter';
import { MAX_BATCH_ITEMS } from './feedback';

const DEFAULT_TIMEOUT_MS = 10_000;
// Deliberately NOT usageReporter's DEFAULT_USAGE_REPORT_BATCH_SIZE (200) —
// feedback.ts's server-side route caps a batch at MAX_BATCH_ITEMS, a much
// lower ceiling than usage-ingest's 500-record cap, since a feedback item
// can carry up to ~72KB of code snippets versus usage's handful of numbers.
// A default above the server's cap would just get every oversized batch
// rejected with a 400, silently dropping otherwise-valid records
// (reportFeedback never retries with a smaller size — it degrades to logging
// a warning, per its never-throw contract). Imported, not restated, so the
// two can't drift independently.
const DEFAULT_FEEDBACK_REPORT_BATCH_SIZE = MAX_BATCH_ITEMS;

export interface FeedbackReportConfig {
  url: string;
  key: string;
  reviewUrl: string; // batch-level context (finding-feedback-requirements.md §5.4's `{ reviewUrl, items }` shape) — every record in this run's batch already carries its own reviewUrl too, so this is redundant-but-harmless per-item, and lets the server default a missing one.
  batchSize?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to Node's global fetch
  timeoutMs?: number;
}

// reportFeedback POSTs this run's FindingFeedback records to a hosted GSR
// finding-feedback endpoint, in batches. Same contract as usageReporter.ts's
// reportUsage: every batch is individually try/caught so one failure doesn't
// stop the rest, and the function itself never throws — a failure here must
// never fail the calling Action run.
export async function reportFeedback(
  records: Array<Omit<FindingFeedback, 'submittedAt'>>,
  config: FeedbackReportConfig
): Promise<{ batchesSent: number; batchesFailed: number }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const batches = chunkRecords(records, config.batchSize ?? DEFAULT_FEEDBACK_REPORT_BATCH_SIZE);
  let batchesSent = 0;
  let batchesFailed = 0;

  for (const batch of batches) {
    const controller = new AbortController();
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Feedback-Key': config.key },
        body: JSON.stringify({ reviewUrl: config.reviewUrl, items: batch }),
        signal: controller.signal,
      });
      if (res.ok) {
        batchesSent++;
      } else {
        batchesFailed++;
        console.warn(`[GSR Action] Feedback report batch rejected: ${res.status}`);
      }
    } catch (err) {
      batchesFailed++;
      console.warn('[GSR Action] Feedback report batch failed:', err);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { batchesSent, batchesFailed };
}
