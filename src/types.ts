export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface CandidateFinding {
  file: string;
  line: number;
  severity: Severity;
  summary: string;
  description: string;
  suggestion?: string; // Optional code suggestion snippet
}

export interface GSRConfig {
  review_settings: {
    min_severity: Severity;
    max_concurrency: number;
  };
  subagents: {
    name: string;
    enabled: boolean;
    paths: string[];
  }[];
}

export interface DiffChunk {
  file: string;
  content: string; // The raw diff string for this specific file
}

export interface Subagent {
  name: string;
  analyze(diff: DiffChunk): Promise<CandidateFinding[]>;
}
