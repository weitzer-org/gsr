import { UsageRecord } from './usage';

export const DEFAULT_USAGE_REPORT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 10_000;

export function chunkRecords<T>(records: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < records.length; i += batchSize) {
    batches.push(records.slice(i, i + batchSize));
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
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
