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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'done') {
          finalFindings = parsed.findings || [];
          finalMetrics = parsed.metrics || { inputTokens: 0, outputTokens: 0, calls: 0 };
          finalEvaluation = parsed.evaluation;
        } else if (parsed.type === 'error') {
          throw new Error(parsed.error || 'Unknown error occurred from API.');
        }
      } catch (e: any) {
        if (e.message !== 'Unexpected token') {
            console.warn('Failed to parse NDJSON line:', line.substring(0, 100));
        }
      }
    }
  }

  // Parse remaining buffer
  if (buffer.trim()) {
    try {
      const parsed = JSON.parse(buffer);
      if (parsed.type === 'done') {
        finalFindings = parsed.findings || [];
        finalMetrics = parsed.metrics || finalMetrics;
        finalEvaluation = parsed.evaluation;
      } else if (parsed.type === 'error') {
        throw new Error(parsed.error);
      }
    } catch(e) {}
  }

  return {
    findings: finalFindings,
    metrics: finalMetrics,
    evaluation: finalEvaluation
  };
}
