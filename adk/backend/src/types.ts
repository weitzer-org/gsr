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

export interface Subagent {
  name: string;
  analyze(chunk: DiffChunk): Promise<CandidateFinding[]>;
}
