export interface DiffChunk {
  file: string;
  content: string;
}

export interface CandidateFinding {
  file: string;
  line: number;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  description: string;
  suggestion?: string;
  agent?: string; // Appended by the orchestrator
}

export interface UsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

export interface AnalyzeResult {
  findings: CandidateFinding[];
  usage?: UsageMetadata;
}

export interface Subagent {
  name: string;
  analyze(chunk: DiffChunk): Promise<AnalyzeResult>;
}

export interface ReviewResult {
  findings: CandidateFinding[];
  metrics: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }
}

