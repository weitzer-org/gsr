// Phase 1 ("observe") of the PR comment feedback loop
// (pr-comment-feedback-loop-design.md §3, §7, §8). Reads GSR's own review
// threads on a PR, classifies each surviving reply, and reports what it
// found. Deliberately posts nothing — Phase 2 ("respond") is a separate,
// not-yet-built pass (adjudication, createThreadReply, the stop conditions
// in §8.4) that would consume this same result.
//
// Self-review finding: this used to say "classifies replies newer than
// anything GSR has already processed" — that's the eventual goal, but not
// what Phase 1 actually does. There's no persisted (or ack-marker-based —
// that's a Phase 2 posting mechanism) cursor to know what's "already
// processed," so every run re-reads and re-classifies every surviving
// reply on every GSR thread, every time, by necessity rather than choice.
// The known cost consequence: on a long-lived PR with many pushes, the
// same old replies get re-classified repeatedly. Accepted for Phase 1 —
// fixing it needs either Action-side persistence or a Phase 2 ack marker,
// neither of which exists yet — revisit once Phase 2 adds one.
//
// Shared, surface-agnostic module (design doc §3.1): action-entrypoint.ts
// and app.ts both call runFeedbackPass with the same inputs and get the
// same outputs; what differs is what each surface does with the result
// (Job Summary vs. an NDJSON frame), never the logic that produced it.
import { GitHubClient } from './github';
import { AdjudicatorAgent, ClassifyReplyInput } from './adjudicator';
import { FindingThread, ThreadReply, ReplyClassification, ReplyStance } from './types';
import { sanitizeForComment } from './findingMarker';

export type FeedbackLoopMode = 'off' | 'observe' | 'respond';

export interface FeedbackPassOptions {
  mode: FeedbackLoopMode;
  maxRepliesClassified?: number;
}

export interface FeedbackReplyReport {
  commentId: number;
  author: string;
  isBot: boolean;
  stance: ReplyStance;
  confidence: number;
  bodyExcerpt: string;
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
  replies: FeedbackReplyReport[];
}

export interface FeedbackPassResult {
  mode: FeedbackLoopMode;
  skipped: boolean;
  skipReason?: string;
  threadsScanned: number;
  repliesClassified: number;
  findings: FeedbackFindingReport[];
}

// Escapes the HTML-bound fields of a FeedbackPassResult for the ONE consumer
// that actually needs HTML-entity-escaping — /api/review's JSON response
// (app.ts). Called there, not baked into the shared report shape (see the
// comment in groupByFinding for why). bodyExcerpt is deliberately excluded
// here — it's already escaped at its single point of origin (excerpt(),
// below), since it has no other consumer to keep raw for.
export function escapeFeedbackResultForApiResponse(result: FeedbackPassResult): FeedbackPassResult {
  return {
    ...result,
    findings: result.findings.map(f => ({
      ...f,
      agent: f.agent ? escapeHtmlEntities(f.agent) : f.agent,
      severity: f.severity ? escapeHtmlEntities(f.severity) : f.severity,
      promptVersion: f.promptVersion ? escapeHtmlEntities(f.promptVersion) : f.promptVersion,
      summary: f.summary ? escapeHtmlEntities(f.summary) : f.summary,
    })),
  };
}

const DEFAULT_MAX_REPLIES_CLASSIFIED = 25;

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
function stage0Filter(reply: ThreadReply): boolean {
  if (SKIP_BOT_LOGINS.has(reply.author)) return false;
  if (!reply.body || EMPTY_OR_EMOJI_ONLY.test(reply.body)) return false;
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

// excerpt() feeds FeedbackFindingReport.bodyExcerpt, which /api/review
// streams verbatim to the browser as part of the 'feedback' NDJSON frame and
// the final 'done' payload (app.ts) — a raw, untrusted GitHub reply body.
// There is no frontend renderer for that field yet (security-review finding:
// this was reaching the HTTP response completely raw), but it must be inert
// by construction the moment one is added, not by whoever writes that future
// code remembering to escape it.
// Self-review finding, raised twice: (1) .slice() counts UTF-16 code units,
// so it can cut a surrogate pair in half (e.g. an emoji), leaving a lone/
// invalid surrogate in the output; (2) spreading the WHOLE string into an
// array (`[...trimmed]`) to fix that allocates an array sized to the full
// input just to keep the first `maxLen` entries, wasteful for a reply body
// that could be much longer than the excerpt it produces. This walks code
// points directly and stops as soon as `maxLen` of them have been counted,
// so the work (and the only slice taken) is bounded by the OUTPUT size, not
// the input size.
function truncateByCodePoint(text: string, maxLen: number): { value: string; truncated: boolean } {
  let count = 0;
  let index = 0;
  for (const ch of text) {
    if (count === maxLen) return { value: text.slice(0, index), truncated: true };
    index += ch.length; // 1 normally, 2 for a surrogate-pair code point
    count++;
  }
  return { value: text, truncated: false };
}

function excerpt(body: string, maxLen = 300): string {
  const trimmed = sanitizeForComment(body).trim();
  const { value, truncated } = truncateByCodePoint(trimmed, maxLen);
  return escapeHtmlEntities(truncated ? `${value}…` : value);
}

function emptyResult(mode: FeedbackLoopMode, skipReason: string): FeedbackPassResult {
  return { mode, skipped: true, skipReason, threadsScanned: 0, repliesClassified: 0, findings: [] };
}

function groupByFinding(
  threads: FindingThread[],
  classificationsByCommentId: Map<number, ReplyClassification>,
  classifiedReplyIds: Set<number>
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
        replies: [],
      };
      byFindingId.set(thread.findingId, entry);
    }
    if (!entry.threadUrls.includes(thread.htmlUrl)) entry.threadUrls.push(thread.htmlUrl);

    for (const reply of classifiedInThisThread) {
      const classification = classificationsByCommentId.get(reply.commentId);
      if (!classification) continue;
      entry.replies.push({
        commentId: reply.commentId,
        author: reply.author,
        isBot: reply.isBot,
        stance: classification.stance,
        confidence: classification.confidence,
        bodyExcerpt: excerpt(reply.body),
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
export async function runFeedbackPass(
  gh: GitHubClient,
  prUrl: string,
  opts: FeedbackPassOptions
): Promise<FeedbackPassResult> {
  if (opts.mode === 'off') {
    return emptyResult('off', 'feedback loop disabled (mode=off)');
  }

  try {
    if (opts.mode === 'respond') {
      // Phase 2 ("respond") — createThreadReply and the posting stop
      // conditions (design doc §8.4) don't exist in this codebase yet.
      // Degrade to the same read-only behaviour as 'observe' rather than
      // silently no-op'ing or throwing on an input value this build simply
      // can't act on yet.
      console.warn('[FeedbackLoop] mode "respond" requested, but posting is not implemented yet — running observe-only.');
    }

    const threads = await gh.listReviewThreads(prUrl);
    const maxRepliesClassified = opts.maxRepliesClassified ?? DEFAULT_MAX_REPLIES_CLASSIFIED;

    type Pending = { thread: FindingThread; reply: ThreadReply };
    const pending: Pending[] = [];
    for (const thread of threads) {
      for (const reply of thread.replies) {
        if (stage0Filter(reply)) pending.push({ thread, reply });
      }
    }

    if (pending.length === 0) {
      // Stage 0 is free — zero surviving replies means zero Gemini calls
      // and zero cost (design doc §10).
      return { mode: opts.mode, skipped: false, threadsScanned: threads.length, repliesClassified: 0, findings: [] };
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

    const findings = groupByFinding(threads, classificationsByCommentId, classifiedReplyIds);

    return {
      mode: opts.mode,
      skipped: false,
      threadsScanned: threads.length,
      repliesClassified: classifications.length,
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
  // CodeRabbit finding: hardcoding "(observe)" mislabels the summary when
  // mode is "respond" (which currently degrades to observe-only behavior,
  // but still reports its requested mode — see runFeedbackPass — so the
  // heading should say what was actually requested).
  lines.push(`## GSR Feedback Loop (${result.mode})`);
  lines.push('');

  if (result.skipped) {
    lines.push(`_Skipped — ${result.skipReason || 'unknown reason'}._`);
    return lines.join('\n');
  }

  lines.push(`Scanned ${result.threadsScanned} GSR thread(s); classified ${result.repliesClassified} repl${result.repliesClassified === 1 ? 'y' : 'ies'}.`);

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

  return lines.join('\n');
}
