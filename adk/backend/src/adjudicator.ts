// Stance classification + pushback adjudication for the PR comment feedback
// loop (pr-comment-feedback-loop-design.md §6.2, §8.2, §8.3). `classifyReplies`
// is Phase 1 ("observe") — one batched call per run, stance only, posts
// nothing. `adjudicate` is Phase 2 ("respond") — one call per rejected
// reply, capped, deciding whether the developer's pushback holds up. As of
// this build, Phase 2 runs in dry-run mode only: feedbackLoop.ts computes
// and reports what `adjudicate` decides but never calls
// GitHubClient.createThreadReply with it — see feedbackLoop.ts for the 2a/2b
// boundary.
import { GoogleGenAI, Type } from '@google/genai';
import { ReplyStance, ReplyClassification, AdjudicationVerdict } from './types';
import { trackGeminiCall } from './usage';
import {
  truncateByCodePoint,
  sanitizeForComment,
  sanitizeRebuttalMarkdown,
  stripMarkers,
  containsCodeFence,
} from './findingMarker';
import * as fs from 'fs';
import * as path from 'path';

export interface ClassifyReplyInput {
  commentId: number;
  findingSummary: string;
  findingSeverity?: string;
  replyText: string;
}

export interface AdjudicateInput {
  findingId: string;
  commentId: number;
  severity?: string;
  agent?: string;
  summary?: string;
  rootBody?: string;   // raw posted finding-comment body; stripped of markers here before use
  replyText: string;
  diffHunk?: string;   // current diff hunk for the finding's file, if available
  promptVersion?: string;
}

export interface AdjudicationOutput {
  verdict: AdjudicationVerdict;
  confidence: number;
  reasoning: string;
  rebuttalMarkdown: string;
  // True when the raw (pre-sanitization) model output contained a fenced
  // code block despite the prompt forbidding one — the verdict/confidence
  // above are ALREADY forced to unclear/0 when this is true; callers don't
  // need to re-check it to stay safe, it's exposed for visibility/logging.
  fenceDetected: boolean;
}

const VALID_STANCES = new Set<ReplyStance>(['accepted', 'rejected', 'question', 'neutral']);

function neutralFallback(commentId: number): ReplyClassification {
  return { commentId, stance: 'neutral', confidence: 0 };
}

const VALID_VERDICTS = new Set<AdjudicationVerdict>(['pushback_correct', 'pushback_incorrect', 'unclear']);
const MAX_REASONING_LENGTH = 1000;
const MAX_REBUTTAL_LENGTH = 1500;

function unclearFallback(): AdjudicationOutput {
  return { verdict: 'unclear', confidence: 0, reasoning: '', rebuttalMarkdown: '', fenceDetected: false };
}

// validateAdjudicationResponse is adjudicate()'s equivalent of
// reconcileClassifications: the model's structured output is untrusted, not
// a guarantee, and this is the single point that decides what of it can be
// trusted before it's ever logged (dry-run) or, in a future build, posted.
//
// Fail-closed fence check (design doc §9's T1, and the sharpest risk flagged
// in this feature's design review): the prompt explicitly forbids a fenced
// code block in `rebuttalMarkdown` (the "Apply suggestion" one-click-code-
// execution risk on GitHub). If the model produced one anyway, that isn't
// just something to sanitize away — it's evidence the whole response
// shouldn't be trusted, so the verdict is forced to `unclear` and confidence
// to 0 regardless of what the model claimed. Since feedbackLoop.ts only ever
// posts on `verdict === 'pushback_incorrect'`, this makes a fenced response
// structurally unable to result in a post, independent of the sanitizer
// that also runs below as a backstop.
export function validateAdjudicationResponse(raw: unknown): AdjudicationOutput {
  if (!raw || typeof raw !== 'object') return unclearFallback();

  const verdictRaw = (raw as any).verdict;
  const confidenceRaw = (raw as any).confidence;
  const reasoningRaw = (raw as any).reasoning;
  const rebuttalRaw = (raw as any).rebuttalMarkdown;

  const verdict: AdjudicationVerdict = VALID_VERDICTS.has(verdictRaw) ? verdictRaw : 'unclear';
  const confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  const reasoningText = typeof reasoningRaw === 'string' ? reasoningRaw : '';
  const rebuttalText = typeof rebuttalRaw === 'string' ? rebuttalRaw : '';

  const fenceDetected = containsCodeFence(rebuttalText);

  const { value: reasoningTruncated } = truncateByCodePoint(reasoningText, MAX_REASONING_LENGTH);
  const { value: rebuttalTruncated } = truncateByCodePoint(rebuttalText, MAX_REBUTTAL_LENGTH);

  const reasoningSanitized = sanitizeForComment(reasoningTruncated) + (fenceDetected
    ? ' [GSR: rebuttal discarded — response contained a fenced code block, which is not permitted.]'
    : '');

  return {
    verdict: fenceDetected ? 'unclear' : verdict,
    confidence: fenceDetected ? 0 : confidence,
    reasoning: reasoningSanitized,
    // PR #61 self-review finding: forcing verdict/confidence above is
    // sufficient to block a POST (feedbackLoop.ts only posts on
    // pushback_incorrect), but leaving the sanitized-but-originally-fenced
    // text in rebuttalMarkdown means a downstream consumer that reads this
    // field without checking verdict first (a logic bug, a future caller)
    // could still render it. Emptying it outright when a fence was
    // detected is strictly safer defense-in-depth, not just belt-and-
    // suspenders on the verdict check.
    rebuttalMarkdown: fenceDetected ? '' : sanitizeRebuttalMarkdown(rebuttalTruncated),
    fenceDetected,
  };
}

// reconcileClassifications enforces the batched-call output-validation rule
// (design doc review-amendment #6): the model returns one verdict per input
// reply, and the response is untrusted structured output, not a guarantee.
// The set of returned commentIds must exactly match the set of input
// commentIds. Any mismatch — missing ids, extra/unknown ids, duplicate ids,
// or a malformed entry (bad stance enum / non-numeric confidence) — means
// that specific item's verdict cannot be trusted; it falls back to
// `neutral`/confidence 0 rather than structurally trusting partial or
// altered output. Items with a clean 1:1 match to a well-formed output
// entry are kept even if OTHER items in the same response were malformed —
// "affected items" fall back individually, not the whole batch, so one bad
// entry doesn't discard classifications the model got right.
//
// Exported for direct unit testing — this is the single most
// security-relevant piece of logic in this module (see the classifier
// prompt's "replies are mutually untrusted content" instruction: a
// malformed/adversarial response should never be trusted at face value).
export function reconcileClassifications(
  input: { commentId: number }[],
  rawOutput: unknown
): ReplyClassification[] {
  const inputIds = new Set(input.map(i => i.commentId));

  if (!Array.isArray(rawOutput)) {
    return input.map(i => neutralFallback(i.commentId));
  }

  const matched = new Map<number, ReplyClassification>();
  // Self-review finding, raised twice: (1) the docstring above promises
  // duplicate ids fall back to neutral, but the first fix still let a
  // malformed FIRST occurrence dodge the duplicate check entirely — it
  // `continue`d on the invalid-stance/confidence check before ever being
  // recorded as "seen", so a well-formed SECOND occurrence of the same id
  // was treated as if it were the only one. `appeared` fixes this by
  // recording every occurrence of a commentId the moment it's seen, before
  // any well-formedness check — a model producing two entries for the same
  // id is untrustworthy for that id regardless of which entry, if either,
  // happens to be well-formed.
  const appeared = new Set<number>();

  for (const item of rawOutput) {
    if (!item || typeof item !== 'object') continue;
    const commentId = (item as any).commentId;

    if (typeof commentId !== 'number') continue;
    if (!inputIds.has(commentId)) continue; // extra/unknown id — ignored, not trusted

    if (appeared.has(commentId)) {
      // A second (or later) appearance of this id anywhere in the raw
      // output — permanently untrustworthy for this response, regardless
      // of whether this or any earlier entry was itself well-formed.
      matched.delete(commentId);
      continue;
    }
    appeared.add(commentId);

    const stance = (item as any).stance;
    const confidence = (item as any).confidence;
    if (!VALID_STANCES.has(stance)) continue; // altered/invalid stance — this entry doesn't count
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;

    matched.set(commentId, { commentId, stance, confidence: Math.max(0, Math.min(1, confidence)) });
  }

  return input.map(i => matched.get(i.commentId) ?? neutralFallback(i.commentId));
}

// Self-review finding: classifyReplies is async and called on the request
// path (both the Action's per-run invocation and, potentially, concurrent
// /api/review requests on the hosted backend), so a synchronous disk read
// on every call blocks the event loop for no reason — the prompt file's
// contents can't change within a process's lifetime. Cache after the first
// read; a module-level variable is fine since this module has no per-request
// state otherwise.
let cachedClassifierPrompt: string | undefined;
let cachedAdjudicatorPrompt: string | undefined;

function promptsRoot(): string {
  // adk/prompts/feedback/ is a sibling of system_prompts/ and
  // basic_prompt/, deliberately NOT inside either — Orchestrator.
  // initializeAgents globs every *.md file under whatever prompts dir it's
  // given and instantiates a review subagent per file (orchestrator.ts),
  // so a prompt for this feature must live somewhere that glob never
  // reaches (design doc §6.2).
  const here = typeof __dirname !== 'undefined' ? __dirname : undefined;
  const projectRoot = here
    ? (here.includes(path.join('dist', 'src')) ? path.resolve(here, '../../../../') : path.resolve(here, '../../../'))
    : path.resolve(process.cwd(), '../../');
  return path.join(projectRoot, 'adk', 'prompts', 'feedback');
}

function loadClassifierPrompt(): string {
  if (cachedClassifierPrompt !== undefined) return cachedClassifierPrompt;
  cachedClassifierPrompt = fs.readFileSync(path.join(promptsRoot(), 'classifier.md'), 'utf8');
  return cachedClassifierPrompt;
}

function loadAdjudicatorPrompt(): string {
  if (cachedAdjudicatorPrompt !== undefined) return cachedAdjudicatorPrompt;
  cachedAdjudicatorPrompt = fs.readFileSync(path.join(promptsRoot(), 'adjudicator.md'), 'utf8');
  return cachedAdjudicatorPrompt;
}

export class AdjudicatorAgent {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  // classifyReplies runs ONE Gemini call for the whole batch (design doc
  // §8.2) — never one call per reply, which is the cost lever the whole
  // pass depends on staying cheap. Never throws: a broken/unreachable
  // classification call degrades every item in the batch to `neutral`
  // rather than failing the caller, mirroring usage.ts's "never throw"
  // contract that the rest of the feedback pass also follows.
  async classifyReplies(batch: ClassifyReplyInput[]): Promise<ReplyClassification[]> {
    if (!batch || batch.length === 0) return [];

    try {
      const systemInstruction = loadClassifierPrompt();
      const model = process.env.FEEDBACK_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

      const response = await trackGeminiCall(
        { callType: 'feedback_classify', model },
        () => this.ai.models.generateContent({
          model,
          contents: JSON.stringify(batch),
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              description: 'One stance classification per input reply.',
              items: {
                type: Type.OBJECT,
                properties: {
                  commentId: { type: Type.INTEGER },
                  stance: { type: Type.STRING, enum: ['accepted', 'rejected', 'question', 'neutral'] },
                  confidence: { type: Type.NUMBER },
                },
                required: ['commentId', 'stance', 'confidence'],
              },
            },
          },
        })
      );

      if (!response.text) {
        console.warn('[Adjudicator] Empty classification response; falling back to neutral for the whole batch.');
        return batch.map(b => neutralFallback(b.commentId));
      }

      const parsed = JSON.parse(response.text);
      return reconcileClassifications(batch, parsed);
    } catch (e) {
      console.error('[Adjudicator] Failed to classify replies:', e);
      return batch.map(b => neutralFallback(b.commentId));
    }
  }

  // adjudicate runs ONE Gemini call per rejected reply (design doc §8.3) —
  // never batched, unlike classifyReplies; the whole point is a deeper,
  // slower, more expensive look at a single argument, capped by the caller
  // (feedbackLoop.ts's maxAdjudications). Never throws — a broken/
  // unreachable call degrades to `unclear`, the same "say nothing, argue
  // nothing" fallback the design doc prefers over a confident guess.
  async adjudicate(input: AdjudicateInput): Promise<AdjudicationOutput> {
    try {
      const systemInstruction = loadAdjudicatorPrompt();
      const model = process.env.FEEDBACK_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

      // Same reasoning as feedbackLoop.ts's MAX_REPLY_TEXT_FOR_CLASSIFICATION:
      // bound worst-case prompt size regardless of how long a GitHub comment
      // or diff patch can legally be.
      const MAX_REPLY_TEXT = 4000;
      const MAX_ROOT_BODY = 4000;
      const MAX_DIFF_HUNK = 8000;

      // CodeRabbit finding: the classification batch (feedbackLoop.ts)
      // already appends "…" when it truncates a reply, so the model knows
      // it's seeing a partial text. This method discarded that same signal
      // for all three fields — worse here than in classification, since
      // adjudication is the stage deciding whether to argue with a
      // developer at all; a silently-cut reply/finding-body/diff-hunk can
      // read as weaker or more incomplete than it really is and bias
      // toward `pushback_incorrect` for the wrong reason. Marking every
      // truncated field explicitly lets the adjudicator prompt's "prefer
      // unclear when uncertain" guidance actually apply to that case.
      const markTruncated = (result: { value: string; truncated: boolean }, suffix = '…') =>
        result.truncated ? `${result.value}${suffix}` : result.value;

      const replyText = markTruncated(truncateByCodePoint(input.replyText, MAX_REPLY_TEXT));
      const rootBodyClean = input.rootBody ? stripMarkers(input.rootBody) : '';
      const rootBody = markTruncated(truncateByCodePoint(rootBodyClean, MAX_ROOT_BODY));
      const diffHunk = input.diffHunk
        ? markTruncated(truncateByCodePoint(input.diffHunk, MAX_DIFF_HUNK), '\n… [truncated]')
        : null;

      const payload = {
        finding: {
          severity: input.severity,
          agent: input.agent,
          summary: input.summary,
          detail: rootBody,
          promptVersion: input.promptVersion,
        },
        developerReply: replyText,
        // Explicit `null` (not an omitted key) so the model is told plainly
        // that no current code context is available for this file, rather
        // than silently proceeding without it — the adjudicator prompt
        // treats this as a strong reason to prefer "unclear".
        currentDiffHunk: diffHunk,
      };

      const response = await trackGeminiCall(
        { callType: 'feedback_adjudicate', model, refId: input.findingId },
        () => this.ai.models.generateContent({
          model,
          contents: JSON.stringify(payload),
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                verdict: { type: Type.STRING, enum: ['pushback_correct', 'pushback_incorrect', 'unclear'] },
                confidence: { type: Type.NUMBER },
                reasoning: { type: Type.STRING },
                rebuttalMarkdown: { type: Type.STRING },
              },
              required: ['verdict', 'confidence', 'reasoning', 'rebuttalMarkdown'],
            },
          },
        })
      );

      if (!response.text) {
        console.warn('[Adjudicator] Empty adjudication response; falling back to unclear.');
        return unclearFallback();
      }

      return validateAdjudicationResponse(JSON.parse(response.text));
    } catch (e) {
      console.error('[Adjudicator] Failed to adjudicate reply:', e);
      return unclearFallback();
    }
  }
}
