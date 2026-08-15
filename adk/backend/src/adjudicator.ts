// Stance classification for the PR comment feedback loop
// (pr-comment-feedback-loop-design.md §6.2, §8.2). Named `adjudicator.ts` to
// match the design doc's file layout — `AdjudicatorAgent` is meant to grow
// an `adjudicate(finding, reply, context)` method in Phase 2 ("respond"),
// which runs a second per-rejection Gemini call to decide whether a
// developer's pushback holds up before GSR ever posts a rebuttal. That
// method is deliberately NOT implemented here: Phase 1 ("observe") only
// classifies and records, it never posts anything, so there is nothing yet
// for an adjudication verdict to gate.
import { GoogleGenAI, Type } from '@google/genai';
import { ReplyStance, ReplyClassification } from './types';
import { trackGeminiCall } from './usage';
import * as fs from 'fs';
import * as path from 'path';

export interface ClassifyReplyInput {
  commentId: number;
  findingSummary: string;
  findingSeverity?: string;
  replyText: string;
}

const VALID_STANCES = new Set<ReplyStance>(['accepted', 'rejected', 'question', 'neutral']);

function neutralFallback(commentId: number): ReplyClassification {
  return { commentId, stance: 'neutral', confidence: 0 };
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
  const seen = new Set<number>();
  // Self-review finding: the docstring above promises duplicate ids fall
  // back to neutral like any other malformed entry, but the code actually
  // implemented "first occurrence wins" — silently trusting whichever
  // duplicate happened to come first instead of treating the duplication
  // itself as a sign the output can't be trusted for that id. `invalidated`
  // makes a duplicate poison its commentId permanently for this response,
  // matching the documented contract.
  const invalidated = new Set<number>();

  for (const item of rawOutput) {
    if (!item || typeof item !== 'object') continue;
    const commentId = (item as any).commentId;
    const stance = (item as any).stance;
    const confidence = (item as any).confidence;

    if (typeof commentId !== 'number') continue;
    if (!inputIds.has(commentId)) continue; // extra/unknown id — ignored, not trusted
    if (invalidated.has(commentId)) continue; // already poisoned by an earlier duplicate
    if (seen.has(commentId)) {
      seen.delete(commentId);
      matched.delete(commentId);
      invalidated.add(commentId);
      continue;
    }
    if (!VALID_STANCES.has(stance)) continue; // altered/invalid stance — this entry doesn't count
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) continue;

    seen.add(commentId);
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

function loadClassifierPrompt(): string {
  if (cachedClassifierPrompt !== undefined) return cachedClassifierPrompt;

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
  const promptPath = path.join(projectRoot, 'adk', 'prompts', 'feedback', 'classifier.md');
  cachedClassifierPrompt = fs.readFileSync(promptPath, 'utf8');
  return cachedClassifierPrompt;
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
}
