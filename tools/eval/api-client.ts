import { Transform } from 'stream';

export interface ReviewMetrics {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface ReviewFinding {
  fileName: string;
  lineNumber: number;
  issueDescription: string;
  suggestion: string;
  severity: string;
  source: string;
  rawResponse?: string;
}

export interface CombinedResult {
  findings: ReviewFinding[];
  metrics: ReviewMetrics;
  evaluation?: string;
  error?: string;
}

/**
 * Sends a review request to the GSR application and aggregates the NDJSON response.
 */
export async function runReview(baseUrl: string, prUrl: string, pat: string): Promise<CombinedResult> {
  const url = `${baseUrl}/api/review`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: prUrl, pat })
  });

  if (!response.ok || !response.body) {
    throw new Error(`API returned ${response.status}: ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let finalFindings: ReviewFinding[] = [];
  let finalMetrics: ReviewMetrics = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let finalEvaluation: string | undefined = undefined;
  let receivedDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      // Parsing and handling are two different failure modes: a malformed line is
      // recoverable (skip and warn), but a `type: 'error'` line is the server
      // deliberately signaling a failed review and must propagate as a real error,
      // not get caught by the same try as a "failed to parse" case and silently
      // logged as a warning — a failed review must never masquerade as a clean
      // zero-findings result.
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (e: any) {
        console.warn('Failed to parse NDJSON line:', line.substring(0, 100));
        continue;
      }
      if (parsed.type === 'done') {
        finalFindings = (parsed.findings || []).map((f: any) => ({
           ...f,
           fileName: f.fileName || f.file || '',
           lineNumber: f.lineNumber || f.line || 1
        }));
        finalMetrics = parsed.metrics || { inputTokens: 0, outputTokens: 0, calls: 0 };
        finalEvaluation = parsed.evaluation;
        receivedDone = true;
      } else if (parsed.type === 'error') {
        throw new Error(parsed.error || 'Unknown error occurred from API.');
      }
    }
  }

  // Parse remaining buffer
  if (buffer.trim()) {
    let parsed: any;
    try {
      parsed = JSON.parse(buffer);
    } catch (e) {
      parsed = undefined;
    }
    if (parsed?.type === 'done') {
      finalFindings = (parsed.findings || []).map((f: any) => ({
         ...f,
         fileName: f.fileName || f.file || '',
         lineNumber: f.lineNumber || f.line || 1
      }));
      finalMetrics = parsed.metrics || finalMetrics;
      finalEvaluation = parsed.evaluation;
      receivedDone = true;
    } else if (parsed?.type === 'error') {
      throw new Error(parsed.error || 'Unknown error occurred from API.');
    }
  }

  // A stream that ends without ever emitting a `done` frame (a dropped
  // connection, a Fly machine restart, a truncated response) previously
  // returned here with zero findings and no error — indistinguishable from a
  // review that legitimately found nothing. A real review can also never
  // report zero calls; both are treated as failures so evaluate.ts's retry
  // logic (which only retries on a thrown error) actually retries them. Kept
  // as two distinct error messages (not one combined check) so operator logs
  // point at the actual failure mode — a dropped connection and a completed-
  // but-empty pipeline call for different debugging, and collapsing them
  // into one message would send whoever reads the log down the wrong path.
  if (!receivedDone) {
    throw new Error('Review stream ended without a valid `done` frame (connection dropped or response truncated).');
  }
  if (finalMetrics.calls === 0) {
    throw new Error('Review stream completed but reported 0 API calls (treated as a failure to trigger evaluation retry).');
  }

  return {
    findings: finalFindings,
    metrics: finalMetrics,
    evaluation: finalEvaluation
  };
}
