// PR comment feedback loop (pr-comment-feedback-loop-design.md §3, §7, §8).
// Reads GSR's own review threads on a PR, classifies each surviving reply
// (Phase 1, "observe"), and — in "respond" mode — additionally adjudicates
// rejected replies to decide whether the developer's pushback holds up
// (Phase 2, §8.3).
//
// Phase 2a/2b boundary: "respond" mode always runs adjudication for real and
// reports exactly what it decided (verdict, confidence, reasoning, the
// rebuttal it would post, and why a would-post candidate was or wasn't
// suppressed) — that decision set (`wouldPost`) is computed identically
// regardless of whether posting is armed. Phase 2b — actually calling
// GitHubClient.createThreadReply — only runs when the caller ALSO sets
// `postRebuttals: true` (the Action's separate `feedback-post` input,
// resolved by feedbackConfig.ts's resolveFeedbackPostEnabled). This is a
// deliberate second, independent opt-in, not a new value of `mode`: existing
// consumers who already set `feedback-loop: respond` for the documented
// dry-run preview (ACTION.md, prior to this build) must see zero behavior
// change unless they explicitly add the new input — silently upgrading
// "respond" to actually post would spring real bot replies on every PR of
// every consumer who opted into a preview, with no action on their part.
// (Independent design review, before this was implemented: confirmed this
// two-flag shape over a third mode value, specifically because
// minConfidence/maxRepliesPosted's descriptions are already scoped to
// "respond mode" and a `post` mode would orphan that wording.)
//
// runAdjudicationStage computes `wouldPost` — unchanged from Phase 2a,
// including when postRebuttals is true — and runPostingStage is a SEPARATE
// stage that runs only over the resulting wouldPost===true set. This split
// is deliberate (design review finding): a failed real POST must never
// promote a candidate that Phase 2a's cap/dedup logic would have suppressed
// in the dry-run preview, so the two decision layers (what SHOULD post vs.
// what actually DID) cannot be allowed to interleave.
//
// Self-review finding (Phase 1): this used to say "classifies replies newer
// than anything GSR has already processed" — that's the eventual goal, but
// not what Phase 1 actually did, since no ack cursor existed yet. Phase 2's
// gsr-reply:v1 marker (github.ts's deriveGsrLastReply) now provides that
// cursor for THREADS GSR has replied to; a thread GSR has never replied to
// still gets every surviving reply reclassified on every run, by necessity
// — there's still no comment-level "already classified" cursor, only a
// reply-level "already ack'd by a rebuttal" one. Accepted, same as Phase 1.
//
// Shared, surface-agnostic module (design doc §3.1): action-entrypoint.ts
// and app.ts both call runFeedbackPass with the same inputs and get the
// same outputs; what differs is what each surface does with the result
// (Job Summary vs. an NDJSON frame), never the logic that produced it. Only
// the Action ever passes mode: 'respond' (or postRebuttals: true) — app.ts
// forces 'observe' and never sets postRebuttals, so the hosted backend
// structurally can never post under GSR's bot identity (design doc §3.2:
// giving it write access would mean posting under the requesting human's
// own PAT, not a bot's — deferred to a future GitHub-App-identity project).
import { GitHubClient } from './github';
import { AdjudicatorAgent, ClassifyReplyInput, AdjudicationOutput } from './adjudicator';
import { FindingThread, ThreadReply, ReplyClassification, ReplyStance, DiffChunk, AdjudicationVerdict, FindingFeedback, FeedbackVerdict } from './types';
import { sanitizeForComment, truncateByCodePoint, buildReplyMarker } from './findingMarker';

export type FeedbackLoopMode = 'off' | 'observe' | 'respond';

export interface FeedbackPassOptions {
  mode: FeedbackLoopMode;
  maxRepliesClassified?: number;
  // The following only take effect in 'respond' mode (Phase 2).
  maxAdjudications?: number;   // cap on rejected replies adjudicated per run (design doc §8.3)
  minConfidence?: number;      // adjudicator confidence floor for a would-post decision (design doc §7.2)
  maxRepliesPosted?: number;   // cap on would-post decisions per run (design doc §7.2, §8.4 layer 5)
  currentDiff?: DiffChunk[];   // this run's diff, for adjudication's diff-hunk context (design doc §8.3 item 3)
  // Phase 2b's arm switch (see the module doc comment above): real posting
  // only happens when this is exactly `true` AND mode is 'respond'. Default
  // false/undefined preserves Phase 2a's dry-run-only behavior exactly —
  // this must never default to true.
  postRebuttals?: boolean;
  // Delay between successive real POSTs within one run (default 1000ms —
  // see DEFAULT_POST_DELAY_MS). GitHub's secondary rate limiting is
  // specifically triggered by rapid content-creation requests, which
  // posting up to maxRepliesPosted replies back-to-back can be; spacing
  // them out is cheap at this cap (default 3). Exposed as an option only so
  // tests don't have to eat the real delay — production call sites should
  // leave this unset.
  postDelayMs?: number;
}

// Suppression reasons for a `pushback_incorrect`-above-threshold verdict
// that nonetheless would NOT post — i.e. a stop condition intervened after
// adjudication decided the finding still stands. 'empty-rebuttal' is
// distinct from the other two: it's not a capacity/dedup stop condition but
// a structural-validity one (see runAdjudicationStage) — the model returned
// a schema-valid empty string for rebuttalMarkdown, which would otherwise
// post a reply containing nothing but an invisible marker.
export type AdjudicationSuppressedReason = 'per-run-cap' | 'duplicate-thread-same-finding' | 'empty-rebuttal';

// Why a `wouldPost === true` candidate did not end up actually posted this
// run (Phase 2b). Distinct from AdjudicationSuppressedReason, which explains
// why adjudication never even reached a would-post decision — these three
// only apply to candidates that DID reach one.
//   fork-read-only         — createThreadReply returned this outcome (a 403:
//                             either a fork PR's read-only GITHUB_TOKEN, or
//                             GitHub's secondary rate limiting — see
//                             github.ts's createThreadReply doc comment).
//                             Sticky for the rest of the run (design doc
//                             §5.3): every later candidate in the same run
//                             is marked this way without a further API call.
//   error                  — createThreadReply failed for any other reason.
//                             NOT sticky — the next candidate is still
//                             attempted normally.
//   concurrent-post-detected — the pre-post re-check (see runPostingStage)
//                             found this finding already has a round on
//                             GitHub, meaning a concurrent run posted first.
export type PostFailedReason = 'fork-read-only' | 'error' | 'concurrent-post-detected';

export interface FeedbackReplyAdjudication {
  verdict: AdjudicationVerdict;
  confidence: number;
  reasoning: string;
  rebuttalMarkdown: string;
  // Whether adjudication + the stop-condition stack (design doc §8.4)
  // decided this rebuttal SHOULD post. Computed identically regardless of
  // whether posting is actually armed (opts.postRebuttals) — this is the
  // dry-run-preview decision, and Phase 2b's posting stage only ever acts
  // on candidates where this is true. See `posted` for what actually
  // happened.
  wouldPost: boolean;
  suppressedReason?: AdjudicationSuppressedReason;
  // Whether GitHubClient.createThreadReply actually succeeded for this
  // candidate this run. Always false when wouldPost is false (nothing was
  // attempted) or when opts.postRebuttals wasn't set (dry run only, same as
  // Phase 2a).
  posted: boolean;
  // Set when wouldPost was true, posting was armed, and the attempt (or the
  // pre-post re-check) didn't result in `posted: true`.
  postFailedReason?: PostFailedReason;
  // The created reply comment's own URL, when posted — lets a human jump
  // straight to what GSR actually said (PRD §5's audit criterion).
  postUrl?: string;
}

export interface FeedbackReplyReport {
  commentId: number;
  author: string;
  isBot: boolean;
  stance: ReplyStance;
  confidence: number;
  bodyExcerpt: string;
  adjudication?: FeedbackReplyAdjudication; // only present in 'respond' mode, for rejected replies that were adjudicated
}

// One entry per distinct finding with at least one classified reply.
// Grouped by findingId, NOT by thread (design-review amendment #5):
// review-quality-design.md §2 documents a separate, known bug where the
// same finding can get posted as multiple duplicate comment threads on one
// PR. Reporting per-thread here would hide that duplication from whoever
// builds Phase 2's "one rebuttal per finding" stop condition — grouping by
// findingId now means a future per-finding posting cap can be built
// directly off this shape instead of a per-thread one that would
// under-protect against duplicate threads.
export interface FeedbackFindingReport {
  findingId: string;
  threadUrls: string[]; // usually one; more than one is itself a signal of the duplicate-thread bug above
  agent?: string;
  severity?: string;
  promptVersion?: string;
  summary?: string;
  // NEW (Phase 3, buildFeedbackRecords below): the root comment's file/line,
  // straight from FindingThread — not carried by the marker itself, but
  // required fields on finding-feedback-requirements.md §5.4's FindingFeedback
  // shape. A finding's content hash already includes file+line, so every
  // thread sharing one findingId agrees on these; taking the first thread's
  // values is safe.
  file?: string;
  line?: number;
  replies: FeedbackReplyReport[];
}

export interface FeedbackPassResult {
  mode: FeedbackLoopMode;
  skipped: boolean;
  skipReason?: string;
  threadsScanned: number;
  repliesClassified: number;
  repliesAdjudicated: number; // NEW (Phase 2): always 0 outside 'respond' mode
  // NEW (Phase 2b): whether this run had posting armed at all
  // (mode === 'respond' && opts.postRebuttals === true) — set once per run,
  // independent of whether there ended up being anything to post. Lets the
  // Job Summary distinguish "dry run" from "live, but nothing to post this
  // time" without inferring it from repliesPosted/repliesPostFailed both
  // being zero, which is ambiguous between those two cases.
  postingEnabled: boolean;
  repliesPosted: number;     // NEW (Phase 2b): successful createThreadReply calls this run
  repliesPostFailed: number; // NEW (Phase 2b): wouldPost===true candidates that did NOT end up posted
  findings: FeedbackFindingReport[];
}

// Escapes the HTML-bound fields of a FeedbackPassResult for the ONE consumer
// that actually needs HTML-entity-escaping — /api/review's JSON response
// (app.ts). Called there, not baked into the shared report shape (see the
// comment in groupByFinding for why). bodyExcerpt is deliberately excluded
// here — it's already escaped at its single point of origin (excerpt(),
// below), since it has no other consumer to keep raw for.
//
// Descends into each reply's `adjudication` (Phase 2) too, not just the
// finding-level fields Phase 1 had — `reasoning`/`rebuttalMarkdown` are
// model-derived text reaching the same HTTP JSON response, and app.ts
// always forces mode to 'observe' (design doc §3.2) so in practice this
// path never carries adjudication data today, but the escaping must not
// depend on that staying true.
export function escapeFeedbackResultForApiResponse(result: FeedbackPassResult): FeedbackPassResult {
  return {
    ...result,
    findings: result.findings.map(f => ({
      ...f,
      agent: f.agent ? escapeHtmlEntities(f.agent) : f.agent,
      severity: f.severity ? escapeHtmlEntities(f.severity) : f.severity,
      promptVersion: f.promptVersion ? escapeHtmlEntities(f.promptVersion) : f.promptVersion,
      summary: f.summary ? escapeHtmlEntities(f.summary) : f.summary,
      // NEW (Phase 3): `file` is a PR diff filename, which CLAUDE.md's
      // Security review section flags as attacker-controlled and already
      // inconsistently escaped elsewhere in this codebase (app.js's
      // renderFindings). Escaped here for the same reason agent/severity/
      // summary already are — this field didn't reach the API response
      // before Phase 3 added it to FeedbackFindingReport, so there's no prior
      // gap to preserve.
      file: f.file ? escapeHtmlEntities(f.file) : f.file,
      replies: f.replies.map(r => r.adjudication ? {
        ...r,
        adjudication: {
          ...r.adjudication,
          reasoning: escapeHtmlEntities(r.adjudication.reasoning),
          rebuttalMarkdown: escapeHtmlEntities(r.adjudication.rebuttalMarkdown),
        },
      } : r),
    })),
  };
}

const DEFAULT_MAX_REPLIES_CLASSIFIED = 25;
const DEFAULT_MAX_ADJUDICATIONS = 5;      // design doc §8.3
const DEFAULT_MIN_CONFIDENCE = 0.7;       // design doc §7.2 (feedback-min-confidence input)
const DEFAULT_MAX_REPLIES_POSTED = 3;     // design doc §7.2 (feedback-max-replies input) / §8.4 layer 5

// Stop-condition layer 1 (design doc §8.4): one rebuttal per finding, ever.
// The design doc frames this as "defaults to 1 with a hard ceiling of 2,"
// implying a knob — this build hardcodes 1 instead. That's a deliberate
// divergence, not an oversight: the product invariant is "the human always
// gets the last word," and a configurable ceiling above 1 is a materially
// different product decision than a configurable classification/posting
// cap. Revisit only as an explicit, separate decision.
const FEEDBACK_MAX_ROUNDS = 1;

// Matches an empty body, or one containing only emoji/whitespace/variation
// selectors/ZWJ — a 👍 reaction-as-comment carries no classifiable stance
// text and would just be wasted batch space (design doc §8.1).
const EMPTY_OR_EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\u200D\uFE0F]*$/u;

// Stage-0 skip list (design doc §8.1, corrected by review-amendment #4):
// GSR's own replies are already excluded at thread-assembly time
// (github.ts's login-based trust check), so this only needs to name OTHER
// well-known review bots whose replies to a GSR finding are never the
// target signal. Deliberately NOT a blanket `isBot` drop — the PRD's
// primary use case is an AI coding agent replying to a finding, and many of
// those show up as `Bot` authors (GitHub App identities) too. Any
// bot-authored reply that isn't one of these two (or GSR itself) is
// classified like any other reply.
const SKIP_BOT_LOGINS = new Set(['coderabbitai[bot]', 'gemini-code-assist[bot]']);

function severityRank(severity?: string): number {
  const scores: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  return scores[(severity || '').toUpperCase()] ?? 0;
}

// stage0Filter drops replies that would waste a classification call. A
// wrong answer here costs nothing — unlike a wrong keyword-based stance
// guess, which is exactly why keyword heuristics were rejected as the
// *classifier* itself (design doc §8.2) and survive only here, as a
// zero-cost pre-filter.
//
// Deliberately does NOT drop replies in a thread that has already hit
// FEEDBACK_MAX_ROUNDS, even though design doc §8.1 lists that as a stage-0
// filter — §8.4's own narrative promises the opposite for a SECOND
// rejection after GSR's one rebuttal: "GSR records the second rejection
// (useful data...) and says nothing further." Recording requires
// classifying it. The round cap is enforced downstream, only against the
// *adjudication/posting* pool (runAdjudicationStage) — not against
// classification, which is comparatively free (§8.2: one batched call for
// everything that survives this filter) and is the mechanism that produces
// the "second rejection" signal §8.4 calls out as useful in its own right.
function stage0Filter(thread: FindingThread, reply: ThreadReply): boolean {
  if (SKIP_BOT_LOGINS.has(reply.author)) return false;
  if (!reply.body || EMPTY_OR_EMOJI_ONLY.test(reply.body)) return false;
  // Already-answered-by-GSR dedupe (design doc §4.1's table: "which replies
  // are new since GSR spoke?" = comment ids greater than ack=). This IS
  // per-thread — a reply's commentId only has meaning relative to ack
  // state recorded in ITS OWN thread, unlike the round cap above, which
  // must be aggregated per finding (see maxRoundByFinding) because of the
  // known duplicate-thread bug (review-quality-design.md §2).
  if (thread.gsrLastReply && reply.commentId <= thread.gsrLastReply.ackCommentId) return false;
  return true;
}

// HTML-entity-escapes a string so it's inert even if some future consumer
// drops it straight into innerHTML. Applied to bodyExcerpt (below) rather
// than left for a future renderer to remember — CLAUDE.md documents this
// exact codebase already shipping the "escaped some fields, not others"
// version of this bug in app.js's renderFindings. escaping here is
// intentionally the plain HTML-entity kind, distinct from
// sanitizeForComment() (which targets marker-forgery/mention-ping hazards
// specific to a *posted GitHub comment*, not arbitrary HTML injection) —
// the two are complementary, not redundant.
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escapeMarkdownUnsafeTags is deliberately narrower than escapeHtmlEntities
// above — used only for rebuttalMarkdown's rendering into the Job Summary
// (appendAdjudicationSections), which is markdown SOURCE fed through
// GitHub's Markdown-then-HTML pipeline, not a JSON/HTTP-response boundary.
// CodeRabbit finding on PR #61 (correcting my own earlier full-escape fix):
// blanket-escaping '<'/'>' there is real overkill — CommonMark doesn't
// re-decode HTML entities inside an inline code span, so a legitimate
// rebuttal referencing `x < 5` in backticks would show a literal "&lt;"
// instead of "<", and a line starting with '>' would lose its blockquote
// formatting. The actual threat is a REAL tag boundary breaking the
// surrounding <details> structure (e.g. an injected `</details>` or
// `<script>`), which only requires neutralizing '<' when it's immediately
// followed by a tag-starting character (a letter, '/', '!', or '?') — the
// only characters that begin a real tag, closing tag, comment, or
// processing instruction. A bare '<' followed by a space/digit/other (as
// in a comparison operator) can never open a tag even to a browser's own
// parser, so leaving it alone is both safe and necessary for readability.
// '>' is never escaped here: with no way to open a tag, a lone '>' can't
// close one either, so it's inert on its own — and leaving it alone is
// what keeps blockquote syntax intact.
function escapeMarkdownUnsafeTags(text: string): string {
  return text.replace(/<(?=[a-zA-Z!/?])/g, '&lt;');
}

// excerpt() feeds FeedbackFindingReport.bodyExcerpt, which /api/review
// streams verbatim to the browser as part of the 'feedback' NDJSON frame and
// the final 'done' payload (app.ts) — a raw, untrusted GitHub reply body.
// There is no frontend renderer for that field yet (security-review finding:
// this was reaching the HTTP response completely raw), but it must be inert
// by construction the moment one is added, not by whoever writes that future
// code remembering to escape it.
// truncateByCodePoint now lives in findingMarker.ts (imported above) —
// adjudicator.ts needs the exact same code-point-safe truncation for
// `reasoning`/`rebuttalMarkdown`, so this was moved rather than duplicated.

function excerpt(body: string, maxLen = 300): string {
  const trimmed = sanitizeForComment(body).trim();
  const { value, truncated } = truncateByCodePoint(trimmed, maxLen);
  return escapeHtmlEntities(truncated ? `${value}…` : value);
}

function emptyResult(mode: FeedbackLoopMode, skipReason: string): FeedbackPassResult {
  return {
    mode, skipped: true, skipReason, threadsScanned: 0, repliesClassified: 0, repliesAdjudicated: 0,
    postingEnabled: false, repliesPosted: 0, repliesPostFailed: 0, findings: [],
  };
}

// maxRoundByFinding aggregates each finding's furthest-along round across
// ALL of a PR's threads sharing that findingId — not per-thread. Necessary
// because of the known duplicate-thread bug (review-quality-design.md §2,
// design doc §15 amendment #5): the same finding can be posted as more than
// one comment thread. A per-thread round check would let a duplicate,
// never-replied-to thread bypass the "one rebuttal per finding, ever"
// invariant even after GSR has already rebutted a sibling thread for the
// exact same finding.
function maxRoundByFinding(threads: FindingThread[]): Map<string, number> {
  const byFinding = new Map<string, number>();
  for (const t of threads) {
    if (t.gsrLastReply) {
      byFinding.set(t.findingId, Math.max(byFinding.get(t.findingId) ?? 0, t.gsrLastReply.round));
    }
  }
  return byFinding;
}

// findDiffHunk looks up the current diff hunk for a thread's file, for
// adjudication context (design doc §8.3 item 3: "the diff hunk... is free,
// and it's the thing that most often settles the argument, because the
// developer may have changed the code between the finding and the reply").
// Returns undefined (not an error) when the file was renamed, its patch was
// too large, or it was filtered out of getPRDiff entirely — the adjudicator
// prompt is told explicitly when no hunk is available and is instructed to
// lean toward "unclear" in that case, rather than this function guessing.
function findDiffHunk(currentDiff: DiffChunk[] | undefined, path: string | undefined): string | undefined {
  if (!currentDiff || !path) return undefined;
  return currentDiff.find(c => c.file === path)?.content;
}

function groupByFinding(
  threads: FindingThread[],
  classificationsByCommentId: Map<number, ReplyClassification>,
  classifiedReplyIds: Set<number>,
  adjudicationsByCommentId: Map<number, FeedbackReplyAdjudication>
): FeedbackFindingReport[] {
  const byFindingId = new Map<string, FeedbackFindingReport>();

  for (const thread of threads) {
    const classifiedInThisThread = thread.replies.filter(r => classifiedReplyIds.has(r.commentId));
    if (classifiedInThisThread.length === 0) continue;

    let entry = byFindingId.get(thread.findingId);
    if (!entry) {
      // Self-review finding, refined by a later one: agent/summary/
      // promptVersion previously got HTML-entity-escaped right here, but
      // this report shape is SHARED by two consumers with different escaping
      // needs — formatFeedbackSummaryMarkdown (Markdown, wants
      // escapeMarkdownTableCell only) and /api/review's JSON response
      // (HTML-bound, wants HTML-entity-escaping). Pre-escaping for the HTML
      // consumer here means the Markdown consumer inherits HTML entities it
      // doesn't want — harmless today only because summary/agent never land
      // inside a Markdown code span in the current formatter, but a latent
      // trap for whoever changes that formatting later without knowing this
      // field was already escaped for a different reason. Kept raw here;
      // HTML-escaping now lives at the actual API-response boundary — see
      // escapeFeedbackResultForApiResponse below, called from app.ts.
      entry = {
        findingId: thread.findingId,
        threadUrls: [],
        agent: thread.agent,
        severity: thread.severity,
        promptVersion: thread.promptVersion,
        summary: thread.summary,
        file: thread.path,
        line: thread.line,
        replies: [],
      };
      byFindingId.set(thread.findingId, entry);
    }
    if (!entry.threadUrls.includes(thread.htmlUrl)) entry.threadUrls.push(thread.htmlUrl);

    for (const reply of classifiedInThisThread) {
      const classification = classificationsByCommentId.get(reply.commentId);
      if (!classification) continue;
      const adjudication = adjudicationsByCommentId.get(reply.commentId);
      entry.replies.push({
        commentId: reply.commentId,
        author: reply.author,
        isBot: reply.isBot,
        stance: classification.stance,
        confidence: classification.confidence,
        bodyExcerpt: excerpt(reply.body),
        ...(adjudication ? { adjudication } : {}),
      });
    }
  }

  return Array.from(byFindingId.values());
}

// runFeedbackPass must never throw (mirrors usage.ts's "never throw"
// contract, per design-review amendment #8): a broken/unreachable feedback
// pass — Octokit failure, a Gemini outage, a malformed response — logs and
// yields a skipped/empty result instead of ever failing the caller's
// primary review flow. action-entrypoint.ts and app.ts both depend on that:
// this pass runs alongside the real review, not ahead of it in the
// failure-blast-radius sense.
type Pending = { thread: FindingThread; reply: ThreadReply };

// runAdjudicationStage is 'respond' mode's Stage 2 (design doc §8.3): it
// computes `wouldPost` for every candidate — identically whether or not
// Phase 2b's posting is armed — and mutates `out`, keyed by commentId,
// rather than returning a new map (kept as a plain side-effecting helper
// since its only caller immediately merges the result into
// groupByFinding's input). It never calls GitHubClient.createThreadReply
// itself; it returns the wouldPost===true subset (in the same
// {thread, reply} shape as its input) so a separate posting stage
// (runPostingStage, below) can act on exactly that set without touching
// this function's cap/dedup decisions — see the module doc comment for why
// that split is deliberate.
async function runAdjudicationStage(
  adjudicator: AdjudicatorAgent,
  capped: Pending[],
  classificationsByCommentId: Map<number, ReplyClassification>,
  threads: FindingThread[],
  opts: FeedbackPassOptions,
  out: Map<number, FeedbackReplyAdjudication>
): Promise<Pending[]> {
  const maxAdjudications = opts.maxAdjudications ?? DEFAULT_MAX_ADJUDICATIONS;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxRepliesPosted = opts.maxRepliesPosted ?? DEFAULT_MAX_REPLIES_POSTED;

  const findingMaxRound = maxRoundByFinding(threads);

  // Stop-condition layer 1 (per-finding — see maxRoundByFinding) and layer
  // 2 ("never answer a bot," design doc §8.4). Note this is NOT the same
  // set of bots Stage 0 drops (SKIP_BOT_LOGINS): Stage 0 only drops two
  // named review bots and still classifies everything else, including an
  // AI coding agent's GitHub App identity, because its stance is real
  // signal. This filter is narrower in scope (adjudication/posting only)
  // but broader in who it excludes (`isBot`, not a fixed list) — GSR simply
  // never argues with a bot-authored reply, indistinguishable-from-human
  // coding agents included. That's the documented design intent, not
  // under-protection against agents specifically.
  const candidates = capped.filter(({ thread, reply }) => {
    const classification = classificationsByCommentId.get(reply.commentId);
    if (!classification || classification.stance !== 'rejected') return false;
    if (reply.isBot) return false;
    if ((findingMaxRound.get(thread.findingId) ?? 0) >= FEEDBACK_MAX_ROUNDS) return false;
    // Design-review finding (ahead of Phase 2b posting going live): don't
    // rebut a rejection the developer has since walked back. Candidate
    // selection was per-reply, so a sequence like "rejected" (R1) then,
    // later in the SAME thread, "actually, you're right" (R2, accepted)
    // still made R1 a candidate — GSR would post a rebuttal arguing against
    // a point the developer already conceded, while simultaneously acking
    // R2 (ackCommentId is always the thread's newest reply) as "answered."
    // Only relevant once posting is real: in dry-run this just meant a
    // slightly confusing preview line, but a live post making this mistake
    // is GSR publicly arguing with someone who already agreed with it — the
    // opposite of the credibility this feature exists to protect (PRD G4).
    // Scoped narrowly to a LATER 'accepted' classification specifically
    // (not 'question'/'neutral', which don't retract a rejection) so this
    // doesn't suppress legitimate candidates over an unrelated later reply.
    const supersededByLaterAcceptance = thread.replies.some(r =>
      r.commentId > reply.commentId && classificationsByCommentId.get(r.commentId)?.stance === 'accepted'
    );
    if (supersededByLaterAcceptance) return false;
    return true;
  });

  candidates.sort((a, b) => severityRank(b.thread.severity) - severityRank(a.thread.severity));
  const cappedCandidates = candidates.slice(0, maxAdjudications);
  if (candidates.length > cappedCandidates.length) {
    console.warn(`[FeedbackLoop] ${candidates.length} rejection(s) eligible for adjudication; adjudicating only the top ${cappedCandidates.length} by severity (maxAdjudications=${maxAdjudications}).`);
  }

  // PR #61 self-review finding: adjudicator.adjudicate() is documented and
  // tested to never throw (it wraps its own body in try/catch and always
  // resolves), which is what makes a bare Promise.all safe here today — but
  // that's a contract enforced by convention, not the type system. Promise.all
  // has fail-fast semantics: if a future change ever regressed that contract
  // and one candidate's promise rejected, the WHOLE batch would be lost — not
  // just that one candidate, but every other candidate's real classification
  // and adjudication work already done this run. Catching per-candidate and
  // dropping only the failed one is cheap insurance against exactly that,
  // consistent with runFeedbackPass's own "one failure must never take down
  // everything else" philosophy.
  const adjudicatedResults = await Promise.all(cappedCandidates.map(async ({ thread, reply }) => {
    try {
      const diffHunk = findDiffHunk(opts.currentDiff, thread.path);
      const output: AdjudicationOutput = await adjudicator.adjudicate({
        findingId: thread.findingId,
        commentId: reply.commentId,
        severity: thread.severity,
        agent: thread.agent,
        summary: thread.summary,
        rootBody: thread.rootBody,
        replyText: reply.body,
        diffHunk,
        promptVersion: thread.promptVersion,
      });
      return { thread, reply, output };
    } catch (err) {
      console.warn(`[FeedbackLoop] Adjudication threw unexpectedly for commentId ${reply.commentId} (finding ${thread.findingId}) — dropping just this candidate:`, err);
      return null;
    }
  }));
  const adjudicated = adjudicatedResults.filter((r): r is NonNullable<typeof r> => r !== null);

  // Layer 4 (only pushback_incorrect above threshold is eligible) + layer 5
  // (per-run posting cap). The per-run cap is deduplicated by findingId,
  // not by thread — same duplicate-thread reasoning as the round cap above:
  // two duplicate threads for one finding could otherwise both reach a
  // would-post decision in the same run, which would be two rebuttals for
  // one finding even though each individual thread only ever gets one.
  // `adjudicated` is already severity-sorted from the candidate list above,
  // so higher-severity findings win ties for the cap.
  //
  // PR #61 self-review + CodeRabbit finding (independently flagged twice):
  // the duplicate-thread check must run BEFORE the per-run-cap check, not
  // after. A candidate that's both past the cap AND a duplicate of an
  // already-counted finding is unconditionally suppressed either way — but
  // which reason gets reported matters, because this report is the exact
  // artifact a human reads to decide whether Phase 2b is safe to enable.
  // Reporting 'per-run-cap' on a permanently-deduplicated candidate would
  // wrongly suggest raising feedback-max-replies unlocks a real rebuttal.
  //
  // PR #61 self-review finding, round 2: reordering alone wasn't enough —
  // `seenFindingIds.add` only ran in the actual would-post branch, so TWO
  // duplicate candidates for a finding that was itself suppressed by an
  // earlier, unrelated finding's cap usage would BOTH report 'per-run-cap'
  // (neither ever got added to the set). The finding must be marked "seen"
  // the moment it's encountered as an eligible candidate at all — whether
  // or not it goes on to actually post — so a later duplicate of it is
  // correctly recognized regardless of why the first one didn't post.
  const seenFindingIds = new Set<string>();
  const wouldPostEntries: Pending[] = [];
  let posted = 0;
  for (const { thread, reply, output } of adjudicated) {
    const eligible = output.verdict === 'pushback_incorrect' && output.confidence >= minConfidence;
    let wouldPost = false;
    let suppressedReason: AdjudicationSuppressedReason | undefined;

    if (eligible) {
      // Structural-validity check, not a capacity/dedup stop condition:
      // rebuttalMarkdown is a REQUIRED field in the response schema
      // (adjudicator.ts), but "required" only means present, not non-empty
      // — a schema-valid `""` would otherwise pass every check below and
      // result in posting a reply containing nothing but an invisible
      // gsr-reply:v1 marker with no visible text. Checked before dedup/cap
      // so it never consumes a finding's one-rebuttal-ever slot
      // (seenFindingIds) — a sibling duplicate thread with a genuine,
      // non-empty rebuttal for the same finding should still be free to
      // post (see design-review discussion on why this doesn't join
      // seenFindingIds).
      if (!output.rebuttalMarkdown.trim()) {
        suppressedReason = 'empty-rebuttal';
      } else if (seenFindingIds.has(thread.findingId)) {
        suppressedReason = 'duplicate-thread-same-finding';
      } else {
        seenFindingIds.add(thread.findingId);
        if (posted >= maxRepliesPosted) {
          suppressedReason = 'per-run-cap';
        } else {
          wouldPost = true;
          posted++;
        }
      }
    }

    if (wouldPost) wouldPostEntries.push({ thread, reply });

    out.set(reply.commentId, {
      verdict: output.verdict,
      confidence: output.confidence,
      reasoning: output.reasoning,
      rebuttalMarkdown: output.rebuttalMarkdown,
      wouldPost,
      suppressedReason,
      posted: false,
    });
  }

  return wouldPostEntries;
}

// DEFAULT_POST_DELAY_MS spaces out successive real POSTs within one run
// (design-review finding): GitHub's secondary rate limiting is specifically
// triggered by rapid content-creation requests, and posting up to
// maxRepliesPosted (default 3) replies back-to-back is exactly that
// pattern. Cheap insurance at this cap.
const DEFAULT_POST_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// runPostingStage is Phase 2b: the ONLY place GitHubClient.createThreadReply
// is ever called. Runs as a stage separate from runAdjudicationStage
// (design-review finding, see the module doc comment) over exactly the
// wouldPost===true set that stage already decided — this function cannot
// itself decide a new candidate should post, only whether an
// already-approved one actually did.
async function runPostingStage(
  gh: GitHubClient,
  prUrl: string,
  wouldPostEntries: Pending[],
  out: Map<number, FeedbackReplyAdjudication>,
  postDelayMs: number
): Promise<{ posted: number; postFailed: number }> {
  // Race mitigation (design review): the dominant interleaving given real
  // adjudication latency (tens of seconds of Gemini calls across the
  // classify + per-rejection adjudicate calls) is "run A posts while run B
  // is still adjudicating," not two near-simultaneous POSTs — a single
  // fresh read here, right before any POST is attempted, catches that
  // window cheaply (one extra paginated GET, only when there's at least one
  // wouldPost candidate). The remaining seconds-wide window between this
  // read and the actual POST is what ACTION.md's recommended `concurrency:`
  // group covers (design doc §7.1) — this check narrows the gap that
  // recommendation has to cover, it doesn't replace it: the Action cannot
  // enforce a consumer's own workflow YAML. Never blocks posting on
  // failure — a broken re-check degrades to "post anyway" (the Phase 2a
  // behavior), not to silently withholding every rebuttal this run.
  let freshMaxRoundByFinding: Map<string, number> | null = null;
  try {
    const freshThreads = await gh.listReviewThreads(prUrl);
    freshMaxRoundByFinding = maxRoundByFinding(freshThreads);
  } catch (err) {
    console.warn('[FeedbackLoop] Pre-post concurrency re-check failed; posting will proceed without it:', err);
  }

  let posted = 0;
  let postFailed = 0;
  // Sticky for the rest of THIS run only (design doc §5.3) — a fresh 403 on
  // a later run gets re-detected independently; there is no cross-run state.
  let forkOrRateLimited = false;

  for (let i = 0; i < wouldPostEntries.length; i++) {
    const { thread, reply } = wouldPostEntries[i];
    const existing = out.get(reply.commentId);
    if (!existing) continue; // unreachable — every wouldPostEntries item was set in runAdjudicationStage

    // The round THIS post is about to claim — not FEEDBACK_MAX_ROUNDS
    // (self-review finding: comparing the concurrency re-check directly
    // against the global cap constant silently coupled two independent
    // things — "how many rounds are allowed at all" and "what round is
    // this specific post" — that happen to be equal only because the cap
    // is hardcoded to 1 today. Computing the actual intended round keeps
    // the check correct on its own terms if that cap ever changes, without
    // this function needing to know why).
    const intendedRound = (thread.gsrLastReply?.round ?? 0) + 1;

    if (freshMaxRoundByFinding && (freshMaxRoundByFinding.get(thread.findingId) ?? 0) >= intendedRound) {
      console.warn(`[FeedbackLoop] Finding ${thread.findingId} already has a reply on GitHub as of the pre-post re-check — a concurrent run likely posted first. Skipping.`);
      out.set(reply.commentId, { ...existing, posted: false, postFailedReason: 'concurrent-post-detected' });
      postFailed++;
      continue; // no API call was made — nothing to space out with a delay
    }

    if (forkOrRateLimited) {
      out.set(reply.commentId, { ...existing, posted: false, postFailedReason: 'fork-read-only' });
      postFailed++;
      continue; // no API call was made — nothing to space out with a delay
    }

    // ack is the newest reply GSR had seen in this thread at post time
    // (design doc §4.1's table) — thread.replies is ascending by id and
    // already excludes GSR's own comments, so its last element is that
    // newest developer/agent reply, not necessarily the one being rebutted
    // (there can be other new replies since GSR last spoke). Falls back to
    // the candidate reply's own id only as defensive programming; every
    // wouldPost candidate implies thread.replies is non-empty (the
    // candidate itself is in it).
    const ackCommentId = thread.replies.length > 0
      ? thread.replies[thread.replies.length - 1].commentId
      : reply.commentId;
    const marker = buildReplyMarker({
      findingId: thread.findingId,
      round: intendedRound,
      verdict: existing.verdict,
      confidence: existing.confidence,
      ackCommentId,
    });
    // Sanitize-then-marker-last (same contract as formatFindingBody):
    // existing.rebuttalMarkdown is ALREADY sanitized + length-capped by
    // adjudicator.ts's validateAdjudicationResponse (sanitizeRebuttalMarkdown)
    // before it ever reached runAdjudicationStage — this only appends the
    // marker after it, never re-sanitizes. parseReplyMarker is end-anchored
    // / last-match-wins (findingMarker.ts), so even if sanitization somehow
    // let a fake marker delimiter through, GSR's own real marker — appended
    // last, here — is still the one a later run trusts.
    //
    // Self-review finding: design doc §9 T1 already accepts, as residual
    // risk, that a determined prompt injector can steer rebuttalMarkdown's
    // CONTENT (the code-level mitigations only constrain whether GSR posts,
    // not what the sanctioned text says) — "impact is bounded... not code
    // execution or data access," but a human reading a confidently-worded
    // reply under a trusted bot identity has no reason to weigh it
    // differently from a genuine finding. REBUTTAL_DISCLAIMER is cheap
    // defense-in-depth directly against that: fixed, non-attacker-derived
    // text (never influenced by rebuttalMarkdown/reasoning/thread content),
    // so it can't itself be a new injection surface, prepended — not
    // appended — so it's the first thing a reader sees, before the argument
    // itself. Deliberately only on the POSTED body, not on
    // existing.rebuttalMarkdown/the stored report value, which stays the
    // model's actual argument for anyone auditing adjudication quality.
    const REBUTTAL_DISCLAIMER = '> 🤖 **Automated rebuttal from GSR.** AI-generated — please verify independently.\n\n';
    const body = `${REBUTTAL_DISCLAIMER}${existing.rebuttalMarkdown}\n\n${marker}`;

    const outcome = await gh.createThreadReply(prUrl, thread.rootCommentId, body);
    if (outcome.posted) {
      out.set(reply.commentId, { ...existing, posted: true, postUrl: outcome.htmlUrl });
      posted++;
    } else {
      out.set(reply.commentId, { ...existing, posted: false, postFailedReason: outcome.reason });
      postFailed++;
      if (outcome.reason === 'fork-read-only') {
        forkOrRateLimited = true;
        console.warn('[FeedbackLoop] Reply post returned 403 (read-only token, e.g. a fork PR, or a rate limit) — degrading to observe for the rest of this run: no further reply posts will be attempted.');
      } else {
        console.warn(`[FeedbackLoop] Reply post failed for commentId ${reply.commentId} (finding ${thread.findingId}): ${outcome.message}`);
      }
    }

    // Only reached after an actual createThreadReply call (the skip
    // branches above `continue` before this point) — spacing out attempts
    // that never happened would just slow the run for no benefit.
    if (i < wouldPostEntries.length - 1 && postDelayMs > 0) {
      await sleep(postDelayMs);
    }
  }

  return { posted, postFailed };
}

// runFeedbackPass must never throw (mirrors usage.ts's "never throw"
// contract, per design-review amendment #8): a broken/unreachable feedback
// pass — Octokit failure, a Gemini outage, a malformed response — logs and
// yields a skipped/empty result instead of ever failing the caller's
// primary review flow. action-entrypoint.ts and app.ts both depend on that:
// this pass runs alongside the real review, not ahead of it in the
// failure-blast-radius sense.
export async function runFeedbackPass(
  gh: GitHubClient,
  prUrl: string,
  opts: FeedbackPassOptions
): Promise<FeedbackPassResult> {
  if (opts.mode === 'off') {
    return emptyResult('off', 'feedback loop disabled (mode=off)');
  }

  // postingEnabled is set once, up front, regardless of whether this run
  // ends up finding anything to post — the Job Summary needs to be able to
  // say "live, but nothing to post this run" distinctly from "dry run"
  // (both would otherwise show repliesPosted === repliesPostFailed === 0).
  const postingEnabled = opts.mode === 'respond' && opts.postRebuttals === true;

  try {
    if (opts.mode === 'respond') {
      // This log line exists so a Job Summary / console reader isn't left
      // assuming "respond" behaves like "observe" (it doesn't — it costs
      // more and computes more) — and, now that Phase 2b exists, states
      // plainly whether THIS run can actually write to GitHub or is
      // dry-run-only.
      console.log(postingEnabled
        ? '[FeedbackLoop] mode "respond" with posting armed (feedback-post): adjudicating rejected replies and posting rebuttals for candidates that clear the confidence threshold, capped and stop-conditioned per design doc §8.4.'
        : '[FeedbackLoop] mode "respond": adjudicating rejected replies in dry-run — verdicts and would-post decisions are computed and reported, but no reply is posted to GitHub (set feedback-post to arm real posting).');
    }

    const threads = await gh.listReviewThreads(prUrl);
    const maxRepliesClassified = opts.maxRepliesClassified ?? DEFAULT_MAX_REPLIES_CLASSIFIED;

    const pending: Pending[] = [];
    for (const thread of threads) {
      for (const reply of thread.replies) {
        if (stage0Filter(thread, reply)) pending.push({ thread, reply });
      }
    }

    if (pending.length === 0) {
      // Stage 0 is free — zero surviving replies means zero Gemini calls
      // and zero cost (design doc §10).
      return {
        mode: opts.mode, skipped: false, threadsScanned: threads.length, repliesClassified: 0, repliesAdjudicated: 0,
        postingEnabled, repliesPosted: 0, repliesPostFailed: 0, findings: [],
      };
    }

    // Ordered by the finding's severity descending before capping (design
    // doc §8.3's ordering, reused for the classification cap too — §13's
    // failure-modes table: "replies classified (25, severity-ordered)").
    pending.sort((a, b) => severityRank(b.thread.severity) - severityRank(a.thread.severity));

    const capped = pending.slice(0, maxRepliesClassified);
    if (pending.length > capped.length) {
      console.warn(`[FeedbackLoop] ${pending.length} reply(ies) survived filtering; classifying only the top ${capped.length} by severity (maxRepliesClassified=${maxRepliesClassified}).`);
    }

    // Self-review finding: maxRepliesClassified bounds the COUNT of replies
    // per batch, but nothing bounded each reply's own length before this —
    // a GitHub comment can be up to ~65KB, so a worst-case batch of 25
    // could send over 1.5MB of text to Gemini in a single call, risking
    // hitting the model's token limit or a large, unbounded cost spike. A
    // real developer/agent reply is realistically a sentence to a short
    // paragraph; this is generous enough for that while bounding the
    // worst case. Truncation-only — no HTML escaping here, this text goes
    // to Gemini, not a browser (see excerpt() in this file for the
    // separate HTML-escaped version used for the HTTP-response excerpt).
    const MAX_REPLY_TEXT_FOR_CLASSIFICATION = 4000;
    const batch: ClassifyReplyInput[] = capped.map(({ thread, reply }) => {
      // Self-review finding: raw .slice() here has the same surrogate-pair-
      // splitting risk as bodyExcerpt did (fixed above via
      // truncateByCodePoint) — reusing that helper instead of a second,
      // separately-fixable copy of the same bug.
      const { value, truncated } = truncateByCodePoint(reply.body, MAX_REPLY_TEXT_FOR_CLASSIFICATION);
      return {
        commentId: reply.commentId,
        findingSummary: thread.summary || (thread.severity ? `${thread.severity} finding` : 'finding'),
        findingSeverity: thread.severity,
        replyText: truncated ? `${value}…` : value,
      };
    });

    const adjudicator = new AdjudicatorAgent();
    const classifications = await adjudicator.classifyReplies(batch);

    const classificationsByCommentId = new Map(classifications.map(c => [c.commentId, c]));
    const classifiedReplyIds = new Set(capped.map(({ reply }) => reply.commentId));

    const adjudicationsByCommentId = new Map<number, FeedbackReplyAdjudication>();
    let repliesPosted = 0;
    let repliesPostFailed = 0;
    if (opts.mode === 'respond') {
      const wouldPostEntries = await runAdjudicationStage(adjudicator, capped, classificationsByCommentId, threads, opts, adjudicationsByCommentId);
      if (postingEnabled && wouldPostEntries.length > 0) {
        const postDelayMs = opts.postDelayMs ?? DEFAULT_POST_DELAY_MS;
        const postResult = await runPostingStage(gh, prUrl, wouldPostEntries, adjudicationsByCommentId, postDelayMs);
        repliesPosted = postResult.posted;
        repliesPostFailed = postResult.postFailed;
      }
    }

    const findings = groupByFinding(threads, classificationsByCommentId, classifiedReplyIds, adjudicationsByCommentId);

    return {
      mode: opts.mode,
      skipped: false,
      threadsScanned: threads.length,
      repliesClassified: classifications.length,
      repliesAdjudicated: adjudicationsByCommentId.size,
      postingEnabled,
      repliesPosted,
      repliesPostFailed,
      findings,
    };
  } catch (err) {
    console.error('[FeedbackLoop] Feedback pass failed; skipping (never fails the main review):', err);
    return emptyResult(opts.mode, err instanceof Error ? err.message : String(err));
  }
}

// --- Job-summary formatting (Action surface) ---
//
// Mirrors usage.ts's formatUsageSummaryMarkdown: pure/independently testable
// from the file-writing side, which lives in action-entrypoint.ts.

// escapeMarkdownTableCell guards against a Gemini-generated summary/agent
// value containing a literal `|`, which would otherwise split into extra
// table columns and corrupt the rendered Job Summary (quick-review finding:
// sanitizeForComment strips comment-delimiter/mention syntax but was never
// meant to be a general markdown escaper, and this is a different render
// target — a Job Summary table cell, not a posted PR comment body).
function escapeMarkdownTableCell(value: string): string {
  // Self-review finding: escaping "|" alone is bypassable when the input
  // already contains a literal backslash right before a pipe. "\|" (2
  // chars) becomes "\\|" (3 chars) under a pipe-only escape — but GFM reads
  // that as an escaped backslash ("\\" → literal "\") followed by an
  // UNESCAPED pipe, which is a real column separator again. Escaping
  // existing backslashes FIRST (so "\|" becomes "\\\|", correctly pairing
  // into an escaped backslash plus an escaped pipe) closes that bypass.
  // Self-review finding: \r?\n normalizes \r\n and \n, but CommonMark treats
  // a standalone \r as a line-ending too — a stray one (possible from some
  // LLM/API/legacy-environment output) would still break the table row.
  // [\r\n]+ squashes any run of either character to a single space.
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function formatFeedbackSummaryMarkdown(result: FeedbackPassResult): string {
  const lines: string[] = [];
  // CodeRabbit finding (Phase 1): hardcoding "(observe)" mislabels the
  // summary when mode is "respond" — the heading says what was actually
  // requested, not a fixed label.
  lines.push(`## GSR Feedback Loop (${result.mode})`);
  lines.push('');

  if (result.skipped) {
    lines.push(`_Skipped — ${result.skipReason || 'unknown reason'}._`);
    return lines.join('\n');
  }

  // Banner: distinguishes dry-run "respond" (Phase 2a — adjudicates and
  // computes would-post decisions but posts nothing, still the default)
  // from live "respond" with feedback-post armed (Phase 2b) — this is the
  // human review artifact both stages exist to produce, so it must be
  // unambiguous which one this run was. Getting this backwards (claiming
  // "nothing was sent" over a section reporting real posts, or vice versa)
  // would undermine the exact human-review gate this feature exists to
  // provide (design review finding, called out explicitly ahead of Phase 2b).
  if (result.mode === 'respond') {
    lines.push(result.postingEnabled
      ? '> **Live.** This run posts rebuttals directly to GitHub for adjudications that clear the ' +
        'confidence threshold, subject to the per-run/per-finding caps below — see "Posted" / "Failed to ' +
        'post" for what actually happened.'
      : '> **Dry run.** This build adjudicates rejected replies and computes what it ' +
        'would post, but posting is not enabled — nothing below was sent to GitHub.');
    lines.push('');
  }

  const adjudicatedNote = result.mode === 'respond'
    ? `; adjudicated ${result.repliesAdjudicated} rejection${result.repliesAdjudicated === 1 ? '' : 's'}`
    : '';
  const postingNote = result.postingEnabled && (result.repliesPosted > 0 || result.repliesPostFailed > 0)
    ? `; posted ${result.repliesPosted}, failed to post ${result.repliesPostFailed}`
    : '';
  lines.push(`Scanned ${result.threadsScanned} GSR thread(s); classified ${result.repliesClassified} repl${result.repliesClassified === 1 ? 'y' : 'ies'}${adjudicatedNote}${postingNote}.`);

  if (result.findings.length === 0) {
    lines.push('');
    lines.push('_No new replies to classify this run._');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('| Finding | Severity | Agent | Replies (stance × confidence) |');
  lines.push('|---|---|---|---|');
  for (const f of result.findings) {
    const replySummary = f.replies
      .map(r => `${escapeMarkdownTableCell(r.author)}: ${r.stance} (${r.confidence.toFixed(2)})`)
      .join('<br/>');
    const summary = f.summary ? escapeMarkdownTableCell(f.summary) : undefined;
    const findingLabel = summary ? `${summary} (\`${f.findingId}\`)` : `\`${f.findingId}\``;
    const agent = f.agent ? escapeMarkdownTableCell(f.agent) : undefined;
    // Self-review finding: severity is enum-constrained by the Gemini
    // response schema on every path that produces it (agent.ts,
    // deduplicator.ts), so it can't actually contain "|" today — but
    // escaping it anyway costs nothing and doesn't depend on that
    // constraint holding forever, same defense-in-depth reasoning as
    // agent/summary above.
    const severity = f.severity ? escapeMarkdownTableCell(f.severity) : undefined;
    lines.push(`| ${findingLabel} | ${severity || '—'} | ${agent || '—'} | ${replySummary} |`);
  }

  if (result.mode === 'respond') {
    appendAdjudicationSections(lines, result.findings, result.postingEnabled);
  }

  return lines.join('\n');
}

// appendAdjudicationSections is the actual payoff of Phase 2a: a human
// reading a real batch of would-post rebuttals, in full (not a truncated
// preview — fable's design-review point: a human approving Phase 2b off a
// shortened rebuttal is approving something they haven't actually seen).
// rebuttalMarkdown is already sanitized + length-capped by adjudicator.ts
// before it ever reaches this function.
//
// This went through two rounds of correction, both worth keeping visible:
// `<details>`/`<summary>` below are raw HTML tags — new in this file (Phase
// 1's Job Summary only ever used Markdown table syntax). Round 1 (my own
// /security-review pass) left them unescaped, reasoning escaping would
// degrade readability — wrong, since rendered HTML entities decode
// transparently. Round 2 (CodeRabbit, on the fix for round 1) correctly
// pointed out that full escaping is ALSO wrong in the other direction: it
// breaks legitimate content, since CommonMark doesn't re-decode entities
// inside an inline code span (`x &lt; 5` shows literally instead of
// `x < 5`) and a `>`-led blockquote line loses its formatting once escaped
// to `&gt;` before the markdown parser ever sees it. `label`/`author` are
// short identifiers never meant to carry markdown formatting, so full
// escapeHtmlEntities is fine for them — but `rebuttalMarkdown` is prose the
// adjudicator prompt allows inline code references in, so it goes through
// escapeMarkdownUnsafeTags instead: narrow enough to preserve that, still
// enough to stop an injected `</details>`/`<script>` from acting on the
// surrounding structure, which is the actual risk (a misleading Job
// Summary undermines the human-review gate this whole dry-run stage exists
// to provide).
function appendAdjudicationSections(lines: string[], findings: FeedbackFindingReport[], postingEnabled: boolean): void {
  const wouldPost: { finding: FeedbackFindingReport; reply: FeedbackReplyReport }[] = [];
  const suppressed: { finding: FeedbackFindingReport; reply: FeedbackReplyReport }[] = [];

  for (const finding of findings) {
    for (const reply of finding.replies) {
      if (!reply.adjudication) continue;
      if (reply.adjudication.wouldPost) {
        wouldPost.push({ finding, reply });
      } else if (reply.adjudication.verdict === 'pushback_incorrect' && reply.adjudication.suppressedReason) {
        suppressed.push({ finding, reply });
      }
    }
  }

  if (wouldPost.length > 0) {
    lines.push('');
    // Phase 2b (design review finding): once posting is armed, this section
    // reports what ACTUALLY happened, not a preview — the heading and each
    // entry's status must say so unambiguously, since a misleading Job
    // Summary here undermines the human-review gate this feature exists to
    // provide. The dry-run heading/wording is UNCHANGED from Phase 2a when
    // posting isn't armed.
    if (postingEnabled) {
      const postedCount = wouldPost.filter(({ reply }) => reply.adjudication!.posted).length;
      lines.push(`### Rebuttals (${postedCount} posted, ${wouldPost.length - postedCount} failed to post)`);
    } else {
      lines.push(`### Would post (${wouldPost.length}) — dry run, nothing was actually sent`);
    }
    for (const { finding, reply } of wouldPost) {
      // PR #61 self-review + CodeRabbit finding (independently flagged
      // twice): escapeMarkdownTableCell is for a Markdown TABLE cell — its
      // pipe-escaping (`|` → `\|`) is meaningless here, since `label` and
      // `author` render inside a raw <summary> HTML tag, not a table row.
      // Applying it anyway made a literal "|" in a finding summary show up
      // as a visible backslash to the reader ("Use A \| B"). Newlines are
      // still collapsed for `label` (finding.summary is LLM-generated free
      // text; a raw embedded newline would split what's meant to be one
      // <summary> line across several, breaking the block) — `author` is a
      // GitHub login, which can't contain a newline by construction, so it
      // doesn't need that defense.
      const label = escapeHtmlEntities((finding.summary || finding.findingId).replace(/[\r\n]+/g, ' '));
      const author = escapeHtmlEntities(reply.author);
      const adjudication = reply.adjudication!;
      // statusPrefix carries the real per-entry outcome once posting is
      // armed — an emoji is enough visual signal at a glance, but the
      // actual word ("Posted"/"Post failed") is what's asserted by tests
      // and what a screen reader gets, not just the glyph.
      const statusPrefix = postingEnabled
        ? (adjudication.posted ? '✅ Posted — ' : `❌ Post failed (${adjudication.postFailedReason || 'error'}) — `)
        : '';
      lines.push('');
      lines.push(`<details><summary>${statusPrefix}${label} — reply from ${author} (confidence ${adjudication.confidence.toFixed(2)})</summary>`);
      lines.push('');
      lines.push(adjudication.rebuttalMarkdown ? escapeMarkdownUnsafeTags(adjudication.rebuttalMarkdown) : '_(empty rebuttal)_');
      if (postingEnabled && adjudication.posted && adjudication.postUrl) {
        lines.push('');
        lines.push(`[View posted comment](${adjudication.postUrl})`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  if (suppressed.length > 0) {
    lines.push('');
    lines.push(`_${suppressed.length} additional "pushback still incorrect" verdict(s) were suppressed by a stop condition ` +
      '(per-run cap, a duplicate thread for a finding already covered above, or an empty rebuttal) and would not have posted this run._');
  }
}

// --- Phase 3 ("report"): mapping onto finding-feedback-requirements.md's
// FindingFeedback shape (design doc §11.2). Only called from
// action-entrypoint.ts (feedbackReporter.ts's sink) — app.ts never reaches
// this, since it forces mode: 'observe' and Stage 3 reporting is Action-only,
// mirroring usageReporter.ts's own Action-only path.

const HTML_ENTITY_DECODE_MAP: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

// unescapeHtmlEntities inverts escapeHtmlEntities in a single regex pass
// (not iterative unescape-then-rescan, which would double-decode legitimate
// literal entity-like text — e.g. a reply that genuinely contains the text
// "&lt;" would, after encoding to "&amp;lt;", incorrectly become "<" under an
// iterative unescape instead of round-tripping back to "&lt;"). Needed
// because bodyExcerpt (see excerpt(), above) is HTML-entity-escaped once at
// creation time for its Job-Summary/API-response consumers — correct for
// those, but wrong for `comment` below, which is meant to preserve the
// developer's actual words for the eventual prompt-tuning dataset (§9.1),
// not an HTML-safe rendering of them.
function unescapeHtmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => HTML_ENTITY_DECODE_MAP[entity]);
}

// mapToFeedbackVerdict implements design doc §11.2's mapping table exactly.
// Returns null for combinations the table doesn't cover — a 'rejected'
// stance with no adjudication (e.g. this pass ran in 'observe' mode, or the
// candidate never reached adjudication) carries no valid/invalid/partial
// signal yet, and 'question'/'neutral' stances aren't verdicts at all.
function mapToFeedbackVerdict(stance: ReplyStance, adjudicationVerdict?: AdjudicationVerdict): FeedbackVerdict | null {
  if (adjudicationVerdict === 'pushback_correct') return 'invalid';   // GSR was wrong
  if (adjudicationVerdict === 'pushback_incorrect') return 'valid';   // GSR stands by it
  if (adjudicationVerdict === 'unclear') return 'partial';
  if (stance === 'accepted') return 'valid';
  return null;
}

// buildFeedbackRecords is Phase 3's export mapping (design doc §11.1/§11.2):
// this loop's data is the right sink for finding-feedback-requirements.md's
// FindingFeedback shape, not a second store. One record per classified reply
// that resolves to a verdict (mapToFeedbackVerdict) — a finding with several
// replies (e.g. a rejection, then GSR's rebuttal, then an acceptance) yields
// one record per reply, not one per finding, since each reply is its own
// independent piece of feedback with its own stance/adjudication.
//
// Known tradeoff: `comment` is built from bodyExcerpt, which excerpt() (above)
// already truncates to 300 characters for its Job-Summary/API-response
// consumers — well under FindingFeedback.comment's 4KB cap. A long reply's
// full text never reaches this export. Reusing the existing excerpt avoids
// plumbing a second, untruncated copy of every reply body through
// FeedbackFindingReport for a field only this one consumer would use;
// revisit if the eventual prompt-tuning dataset (§9.1) proves 300 characters
// too lossy.
export function buildFeedbackRecords(result: FeedbackPassResult, reviewUrl: string): Array<Omit<FindingFeedback, 'submittedAt'>> {
  if (result.skipped) return [];

  const records: Array<Omit<FindingFeedback, 'submittedAt'>> = [];
  for (const finding of result.findings) {
    for (const reply of finding.replies) {
      const verdict = mapToFeedbackVerdict(reply.stance, reply.adjudication?.verdict);
      if (!verdict) continue;

      records.push({
        findingId: finding.findingId,
        file: finding.file || 'unknown',
        line: finding.line ?? 0,
        severity: finding.severity || 'UNKNOWN',
        agent: finding.agent || 'unknown',
        summary: finding.summary || finding.findingId,
        reviewUrl,
        promptVersion: finding.promptVersion,
        verdict,
        comment: unescapeHtmlEntities(reply.bodyExcerpt),
        // submittedBy is always 'gsr-feedback-loop' — per §5.2.1's note on
        // submittedBy being a self-reported attribution trail, this is
        // honest about the record being GSR's own inference from a GitHub
        // reply, not a human's/agent's directly stated position (§11.2).
        submittedBy: 'gsr-feedback-loop',
        source: 'pr-thread',
        threadUrl: finding.threadUrls[0],
        stance: reply.stance,
        adjudication: reply.adjudication ? {
          verdict: reply.adjudication.verdict,
          confidence: reply.adjudication.confidence,
          reasoning: reply.adjudication.reasoning,
        } : undefined,
      });
    }
  }
  return records;
}
