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
  path?: string;     // NEW (Phase 2): root comment's file path, from the GitHub API directly
                      // (not the marker — the marker has no file= field). Used to look up
                      // the matching diff hunk for adjudication context.
  line?: number;      // NEW (Phase 2): root.original_line (falls back to root.line) — see
                       // github.ts's legacy-fallback comment for why original_line is preferred.
  contentHash?: string; // NEW (repost-suppression): the marker's `h=` field, when present —
                         // only ever set on a `gsr:v2` marker (see findingMarker.ts's
                         // computeContentHash). Undefined for v1/legacy threads.
  repostCount?: number; // NEW (repost-suppression): the marker's `n=` field, when present —
                         // see repostSuppression.ts for how this is read/incremented.
  rootBody?: string;   // NEW (Phase 2): the raw posted finding-comment body, for adjudication
                        // context (description/suggestion aren't separately structured fields
                        // today — only baked into the rendered comment). Strip markers via
                        // findingMarker.ts's stripMarkers() before handing to a prompt.
  gsrLastReply?: {      // NEW (Phase 2): derived from GSR's own gsr-reply:v1 marker(s) in this
                        // thread, if any — see github.ts's deriveGsrLastReply for the
                        // fail-closed derivation.
    round: number;
    ackCommentId: number;
    verdict: AdjudicationVerdict;
    confidence: number;
  };
  replies: ThreadReply[]; // non-GSR comments in the thread, ascending by id
}

export interface ReplyClassification {
  commentId: number;
  stance: ReplyStance;
  confidence: number; // 0..1
}

// --- PR comment feedback loop, Phase 2 ("respond") ---
// Adjudication decides whether a developer's REJECTION of a finding holds
// up (design doc §8.3). `unclear` and `pushback_correct` are recorded
// silently; only `pushback_incorrect` above a confidence threshold is
// eligible to post a rebuttal (design doc §8.4, layer 4) — enforced in
// code (feedbackLoop.ts), not left to the model's discretion.
export type AdjudicationVerdict = 'pushback_correct' | 'pushback_incorrect' | 'unclear';

export interface Adjudication {
  findingId: string;
  commentId: number;
  verdict: AdjudicationVerdict;
  confidence: number; // 0..1
  reasoning: string;  // sanitized + length-capped before this is ever constructed — see adjudicator.ts
}

// --- Finding feedback (finding-feedback-requirements.md §5.4) ---
// The durable record POSTed to /api/findings/feedback. `source`, `threadUrl`,
// `stance`, `adjudication` are pr-comment-feedback-loop-design.md §11.2's
// additions — this repo's own PR-comment loop is one of (potentially several)
// producers of this shape, alongside an external coding agent's direct push.

export type FeedbackVerdict = 'valid' | 'invalid' | 'partial';

export interface FindingFeedback {
  // What finding this is about (self-contained snapshot, not a lookup —
  // §5.3: the payload carries enough to stand on its own even for an Action
  // run that never persisted the original finding).
  findingId: string;
  file: string;
  line: number;
  severity: string;
  agent: string;
  summary: string;

  // Context
  reviewUrl: string;
  promptVersion?: string;

  // The feedback itself
  verdict: FeedbackVerdict;
  comment: string;

  // Optional: what the consumer actually did about it
  exampleCodeBefore?: string;
  exampleCodeAfter?: string;
  codeFeedback?: string;

  // Provenance
  submittedBy: string;
  submittedAt: string; // ISO 8601, server-assigned — any caller-provided value is ignored

  // NEW (pr-comment-feedback-loop-design.md §11.2)
  source?: 'agent-push' | 'pr-thread';
  threadUrl?: string;
  stance?: ReplyStance;
  adjudication?: {
    verdict: AdjudicationVerdict;
    confidence: number;
    reasoning: string;
  };
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

