export interface DiffChunk {
  file: string;
  content: string;
}

export enum ReviewSource {
  SUBAGENT = 'subagent',
  BASIC = 'basic'
}

export interface CandidateFinding {
  file: string;
  line: number;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  summary: string;
  description: string;
  suggestion?: string;
  agent?: string; // Appended by the orchestrator
  source?: ReviewSource; // Identifies which review process found it
  id?: string; // NEW (feedback loop Phase 0): findingId = computeFindingId(...), see findingMarker.ts.
               // Optional so nothing existing breaks; populated by Orchestrator's flattening loop.
  promptVersion?: string; // NEW (feedback loop Phase 0): the promptsDirName that produced this
                           // finding (e.g. "system_prompts"). Survives even if that prompts dir is
                           // later renamed or removed, since it's baked into the finding/marker at
                           // creation time rather than looked up later.
}

// --- PR comment feedback loop (see pr-comment-feedback-loop-design.md) ---
// Phase 0/1 types only — adjudication (`AdjudicationVerdict`, posting) is
// Phase 2 and deliberately not modeled here yet.

// A reply's classified stance toward the finding it responds to.
//   accepted — developer agrees/fixed it
//   rejected — developer disagrees, thinks it's wrong/not applicable
//   question — neither acceptance nor rejection (out of scope for v1, PRD §4)
//   neutral  — ambiguous, unclassifiable, or a classification-pipeline fallback
export type ReplyStance = 'accepted' | 'rejected' | 'question' | 'neutral';

export interface ThreadReply {
  commentId: number;
  author: string;
  isBot: boolean;
  createdAt: string;
  body: string;
}

export interface FindingThread {
  rootCommentId: number;
  htmlUrl: string;
  findingId: string;
  agent?: string;
  severity?: CandidateFinding['severity'];
  promptVersion?: string;
  summary?: string; // recovered from the root comment's rendered header line (not carried
                     // in the marker itself); used as classifier context, best-effort
  replies: ThreadReply[]; // non-GSR comments in the thread, ascending by id
}

export interface ReplyClassification {
  commentId: number;
  stance: ReplyStance;
  confidence: number; // 0..1
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
  analyze(chunks: DiffChunk[]): Promise<AnalyzeResult>;
  promptContent?: string;
}

export interface ReviewResult {
  findings: CandidateFinding[];
  metrics: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
  }
}

