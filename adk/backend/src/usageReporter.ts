import { UsageRecord } from './usage';

export const DEFAULT_USAGE_REPORT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 10_000;

// A non-positive or non-finite batchSize would otherwise never advance `i`
// (or move it backward), hanging this loop forever — guard here rather than
// at each call site, since this is the one place that actually walks `i`.
export function chunkRecords<T>(records: T[], batchSize: number): T[][] {
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : DEFAULT_USAGE_REPORT_BATCH_SIZE;
  const batches: T[][] = [];
  for (let i = 0; i < records.length; i += size) {
    batches.push(records.slice(i, i + size));
  }
  return batches;
}

export interface UsageReportConfig {
  url: string;
  key: string;
  repository?: string;
  batchSize?: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to Node's global fetch
  timeoutMs?: number;
}

// reportUsage POSTs a run's collected usage records to a hosted GSR
// usage-ingest endpoint, in batches. This is an opt-in convenience feature
// for maintainer-approved repos (see ACTION.md) — every batch is
// individually try/caught so one failure doesn't stop the rest, and the
// function itself never throws, mirroring usage.ts's recordUsage "never
// throw" contract: a failure here must never fail the calling Action run.
export async function reportUsage(records: UsageRecord[], config: UsageReportConfig): Promise<{ batchesSent: number; batchesFailed: number }> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const batches = chunkRecords(records, config.batchSize ?? DEFAULT_USAGE_REPORT_BATCH_SIZE);
  let batchesSent = 0;
  let batchesFailed = 0;

  for (const batch of batches) {
    const controller = new AbortController();
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Usage-Ingest-Key': config.key },
        body: JSON.stringify({ repository: config.repository, records: batch }),
        signal: controller.signal,
      });
      if (res.ok) {
        batchesSent++;
      } else {
        batchesFailed++;
        console.warn(`[GSR Action] Usage report batch rejected: ${res.status}`);
      }
    } catch (err) {
      batchesFailed++;
      console.warn('[GSR Action] Usage report batch failed:', err);
    } finally {
      clearTimeout(timeout);
    }
  }

  return { batchesSent, batchesFailed };
}
