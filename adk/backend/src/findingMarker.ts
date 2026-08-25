// Marker mechanism for the PR comment feedback loop
// (pr-comment-feedback-loop-design.md §4, §6.2, §9). Every finding GSR posts
// carries an invisible HTML-comment marker in its comment body so a later
// run can read the PR thread itself as the system of record — no database,
// no Action-side persistence. This module owns building/parsing that marker
// and the security-sensitive text handling around it (sanitization, legacy
// fallback, and the findingId hash three different features now share).
//
// Security note (design doc §9, T2 "marker forgery / injection"): the
// markers ARE the state store, so text that can write markers can rewrite
// state. This module only extracts/formats syntax — it does not decide
// whether a marker should be *trusted*. Trust is a property of who authored
// the comment (see github.ts's login-based check), not of whether the
// marker parses. Callers must not treat a well-formed marker on an
// untrusted comment as authoritative.

import { createHash } from 'crypto';
import { CandidateFinding, AdjudicationVerdict } from './types';

export interface FindingMarker {
  version: 'v1' | 'v2';
  findingId: string;
  agent?: string;
  severity?: string;
  promptVersion?: string;
  createdAt?: string;
}

export interface LegacyFindingInfo {
  severity: string;
  agent?: string;
  summary: string;
}

// ReplyMarker is Phase 2's counterpart to FindingMarker (design doc §4.1,
// §6.1) — appended to GSR's own rebuttal reply so a later run can recover
// round/verdict/confidence/ack without any persistence. `round` starts at 1;
// `ack` is the id of the newest developer reply GSR had seen when it spoke,
// which is how "has GSR already answered this specific reply" gets a
// precise, stateless answer (design doc §4.1's table).
export interface ReplyMarker {
  version: 'v1';
  findingId: string;
  round: number;
  verdict: AdjudicationVerdict;
  confidence: number;
  ackCommentId: number;
}

// --- findingId ---
//
// v1 (superseded — see review-quality-design.md §2.1 addendum, 2026-08-24):
// hashed `file | line | agent | summary`. Confirmed broken as a
// restatement-stable identity: `summary` is LLM-generated prose that isn't
// byte-stable across two runs that found "the same" issue, and raw `line`
// shifts on every push even for an unmoved finding — 6 restatements of one
// finding on job_tracker PR #76 produced 6 different hashes. `summary` is
// dropped entirely below rather than tolerance-matched (there's no principled
// fuzzy-text threshold that isn't itself another source of drift); `line` is
// bucketed instead of dropped, since file+agent alone would collide two
// genuinely-different findings in the same file too often to be useful.
//
// v2 (current): `file | lineBucket | agent | category`, no `summary`.
// Bucketing trades precision for stability — a finding a few lines from a
// bucket boundary can still flip buckets on an unrelated edit above it, and
// two distinct findings landing in the same bucket on the same file/agent
// will collide onto one id (the second overwrites/suppresses the first on
// repost-suppression day). Accepted: false-merges are cheaper than the
// status quo of near-100%-miss identity. `category` is a forward-compatible
// slot — no finding shape carries a category field yet, so it's always ''
// today; the moment one does, the hash starts using it for free without
// another version bump.
const LINE_BUCKET_SIZE = 10;

function bucketLine(line: number): number {
  return Math.floor(line / LINE_BUCKET_SIZE);
}

// Self-review finding: deduplicator.ts's prompt asks Gemini to "concatenate
// the agent names with commas (e.g., 'Performance, Security')" for a merged
// finding, with no ordering rule — an LLM restating the same merge across
// two runs could plausibly emit "Performance, Security" once and "Security,
// Performance" another time. Hashing that raw would reintroduce exactly the
// restatement-instability this v2 scheme exists to fix, just moved from
// `summary` to `agent`. Sorting the comma-separated components before
// hashing makes the id invariant to the LLM's chosen order; a normal
// single-agent finding (the common case, no comma) is unaffected since
// sorting a one-element array is a no-op.
function normalizeAgent(agent: string): string {
  return agent.split(',').map(a => a.trim()).filter(Boolean).sort().join(', ');
}

export function computeFindingId(input: { file: string; line: number; agent?: string; category?: string }): string {
  const agent = input.agent ? normalizeAgent(input.agent) : '';
  const key = `${input.file}|${bucketLine(input.line)}|${agent}|${input.category || ''}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// findingIdFor is a small convenience wrapper so call sites can pass a
// CandidateFinding directly without restating its fields. `category` isn't
// on CandidateFinding (nothing produces one yet — see computeFindingId), so
// it's added to the parameter type by intersection rather than Pick, same
// forward-compatible-and-currently-unused status as computeFindingId's own
// optional `category` field.
export function findingIdFor(finding: Pick<CandidateFinding, 'file' | 'line' | 'agent'> & { category?: string }): string {
  return computeFindingId(finding);
}

// --- sanitizeForComment ---
//
// The single most important function in this module (design doc §9, T2).
// Applied to every model/diff-derived string (summary, description,
// suggestion, and later — Phase 2 — rebuttal text) before it goes anywhere
// near a posted comment body. Two independent threats, both neutralized
// unconditionally regardless of how the text got here:
//
//   T2 — marker forgery: a prompt-injected diff or finding could otherwise
//   make Gemini emit literal `<!-- gsr:v1 ... -->` / `<!-- gsr-reply:v1 ... -->`
//   syntax inside a finding's own text, either to forge a marker or to inject
//   text ahead of GSR's own real marker. Stripping `<!--`/`-->` outright
//   (not escaping) removes the hazard while leaving the sentence readable,
//   and composes with parseFindingMarker's end-anchored/last-match behavior:
//   between this function removing fake delimiters and formatFindingBody
//   always appending the real marker last, the last well-formed marker in a
//   posted comment is guaranteed to be GSR's own.
//
//   T3 — mention/notification abuse: text that reaches a posted comment
//   under GSR's bot identity could otherwise mass-ping "@org/team" verbatim.
//   A zero-width space after '@' keeps the text visually identical to a
//   human reader while breaking GitHub's mention parsing.
const FORBIDDEN_DELIMITERS = ['<!--', '-->'];

// Self-review finding (raised again, independently, against the first fix's
// loop-to-fixed-point version): repeatedly re-scanning the whole string with
// a global regex correctly handles the nested-bypass case (see
// sanitizeForComment below) but is worst-case O(N\u00B2) \u2014 an adversarially
// nested input can force close to N/4 passes, each rescanning up to N
// characters. This does the same job \u2014 removing "<!--"/"-->" including
// occurrences only formed by adjacency after an earlier removal \u2014 in one
// O(N) pass: push characters onto a stack, and whenever the stack's tail
// now spells a forbidden sequence, pop it off instead of keeping it. Each
// character is pushed and popped at most once, so the total work is linear
// regardless of how deeply the input is nested.
// Self-review finding: `stack.slice(-seq.length).join('')` allocates a new
// array and string on every character just to compare the stack's tail —
// still O(N) overall (seq.length is a small constant), but avoidable.
// Compares by index instead, with no allocation.
function stackEndsWith(stack: string[], seq: string): boolean {
  if (stack.length < seq.length) return false;
  const offset = stack.length - seq.length;
  for (let i = 0; i < seq.length; i++) {
    if (stack[offset + i] !== seq[i]) return false;
  }
  return true;
}

function stripNestedDelimiters(text: string): string {
  const stack: string[] = [];
  for (const ch of text) {
    stack.push(ch);
    for (const seq of FORBIDDEN_DELIMITERS) {
      if (stackEndsWith(stack, seq)) {
        stack.length -= seq.length;
        break;
      }
    }
  }
  return stack.join('');
}

export function sanitizeForComment(text: string): string {
  if (!text) return text;

  let out = stripNestedDelimiters(text);

  // Self-review finding: matching "@" + word-char unconditionally also
  // corrupts legitimate email addresses in finding text (e.g.
  // "hardcoded credential for admin@example.com" becomes
  // "admin@\u200Bexample.com"). Only treat it as a mention to neutralize
  // when the "@" isn't already embedded in a word/dotted/hyphenated
  // token \u2014 real @mentions are preceded by whitespace or start-of-string.
  out = out.replace(/(?<![\w.-])@(\w)/g, '@\u200B$1');
  return out;
}

// --- Phase 2 additions: rebuttal-text handling and code-point-safe truncation ---
//
// truncateByCodePoint moved here from feedbackLoop.ts (Phase 1) because
// adjudicator.ts now needs the exact same code-point-safe truncation for
// `reasoning`/`rebuttalMarkdown` \u2014 a plain .slice() can cut a surrogate pair
// in half (e.g. an emoji), leaving a lone/invalid surrogate in the output.
// Kept as one implementation rather than a second copy of an already-fixed
// bug class.
export function truncateByCodePoint(text: string, maxLen: number): { value: string; truncated: boolean } {
  // PR #61 self-review finding: `text.length` (UTF-16 code units) is always
  // >= the actual code-point count (a surrogate pair contributes 2 code
  // units for 1 code point), so it's a safe upper bound — if it already
  // fits within maxLen, no truncation could possibly be needed, and the
  // per-character iteration below (one short-string allocation per
  // code point) can be skipped entirely. This is the common case for most
  // reply/finding text, so the fast path matters in practice, not just in
  // the worst case.
  if (text.length <= maxLen) return { value: text, truncated: false };

  let count = 0;
  let index = 0;
  for (const ch of text) {
    if (count === maxLen) return { value: text.slice(0, index), truncated: true };
    index += ch.length; // 1 normally, 2 for a surrogate-pair code point
    count++;
  }
  return { value: text, truncated: false };
}

// containsCodeFence detects a Markdown fenced code block (3+ backticks OR
// 3+ tildes \u2014 GFM supports both) in RAW, unsanitized adjudicator output.
// Used as a fail-closed signal in adjudicator.ts: if the model emitted a
// fence despite the prompt explicitly forbidding one, that is itself
// evidence of misbehavior or injection, so the caller forces the verdict to
// `unclear` rather than trusting a sanitized-but-still-suspicious response.
// This is checked on the RAW text, before neutralizeFences() below ever
// touches it, so sanitization can't hide the signal from the caller.
export function containsCodeFence(text: string): boolean {
  return /[`~]{3,}/.test(text || '');
}

// neutralizeFences breaks up any run of 3+ backticks or 3+ tildes \u2014 the
// same technique sanitizeForComment already uses for `@mentions`. This is
// deliberately blanket (not scoped to ```suggestion specifically): GFM
// tolerates leading-space indentation, info-string whitespace, fences
// inside blockquotes, and casing quirks, so pattern-matching only the
// exploitable ```suggestion form is a parser-differential game that's easy
// to lose. Categorically preventing GSR's bot identity from ever rendering
// ANY fenced code block in an argumentative rebuttal \u2014 not just GitHub's
// "Apply suggestion"-triggering one \u2014 is simpler and strictly safer.
//
// PR #61 self-review finding: inserting a SINGLE zero-width space (after
// the first character only) only neutralizes a run of EXACTLY 3 \u2014 a run of
// 4+ (e.g. "````") left `seq.slice(1)` as 3 still-consecutive backticks,
// still a valid fence GFM would render. A fence is any run of 3-OR-MORE, so
// neutralizing it requires breaking every adjacent pair, not just the
// first one: interleave a zero-width space between EVERY character so no
// substring of length \u22653 (or even \u22652 wouldn't matter, but \u22653 is the
// relevant threshold) survives intact, regardless of the run's length.
const FENCE_RUN_PATTERN = /[`~]{3,}/g;
function neutralizeFences(text: string): string {
  return text.replace(FENCE_RUN_PATTERN, (seq) => seq.split('').join('\u200B'));
}

// sanitizeRebuttalMarkdown is the rebuttal-specific sibling of
// sanitizeForComment \u2014 applied to `rebuttalMarkdown` (adjudicator.ts)
// specifically for the "Apply suggestion" one-click-code-execution risk
// (design doc \u00A79), in addition to (not instead of) the marker-forgery/
// mention-ping hazards sanitizeForComment already covers.
export function sanitizeRebuttalMarkdown(text: string): string {
  if (!text) return text;
  return sanitizeForComment(neutralizeFences(text));
}

// --- Marker build/parse ---

function encodeField(value: string): string {
  // Percent-encoding keeps every field whitespace-free (so the marker stays
  // a simple space-delimited token stream) even for values containing
  // spaces or commas — e.g. the deduplicator concatenates agent names as
  // "Performance, Security" (deduplicator.ts).
  return encodeURIComponent(value);
}

function decodeField(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding (e.g. hand-typed/forged marker text) —
    // return the raw token rather than throwing; parseMarkerFields' `f=`
    // validation below will reject anything that doesn't look like a hash.
    return value;
  }
}

// buildFindingMarker renders the marker formatFindingBody appends to every
// finding comment (design doc §4.1). `createdAt` defaults to "now" so call
// sites don't all need to thread a timestamp through. Always writes the
// current marker version (v2, §2.1 addendum) — v1 is a read-only format now,
// kept only so parseFindingMarker can still recognize markers already live
// on posted comments (see that function).
const CURRENT_MARKER_VERSION = 'v2';

export function buildFindingMarker(marker: Omit<FindingMarker, 'version'>): string {
  const parts = [`f=${encodeField(marker.findingId)}`];
  if (marker.agent) parts.push(`a=${encodeField(marker.agent)}`);
  if (marker.severity) parts.push(`s=${encodeField(marker.severity)}`);
  if (marker.promptVersion) parts.push(`pv=${encodeField(marker.promptVersion)}`);
  parts.push(`r=${encodeField(marker.createdAt || new Date().toISOString())}`);
  return `<!-- gsr:${CURRENT_MARKER_VERSION} ${parts.join(' ')} -->`;
}

function parseMarkerFields(raw: string, version: 'v1' | 'v2'): FindingMarker | null {
  const fields: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) continue; // no '=' or empty key — malformed token, ignored (unknown/bad keys don't invalidate the rest)
    const key = token.slice(0, eq);
    fields[key] = decodeField(token.slice(eq + 1));
  }
  // f= is the only required field, and must look like a hex hash — anything
  // else means this isn't really a gsr marker, well-formed HTML comment
  // syntax notwithstanding.
  if (!fields.f || !/^[0-9a-f]+$/i.test(fields.f)) return null;
  return {
    version,
    findingId: fields.f,
    agent: fields.a,
    severity: fields.s,
    promptVersion: fields.pv,
    createdAt: fields.r,
  };
}

// parseFindingMarker extracts GSR's finding marker from a comment body.
//
// Matches BOTH `gsr:v1` (superseded hash, still live on comments already
// posted to this repo, job_tracker, and sound-profile-builder before the
// §2.1 addendum) and `gsr:v2` (current) — a v1 marker's `findingId` is
// returned as-is (already-computed text, not recomputed), so old comments
// keep parsing exactly as before. See the §2.1 addendum's decision on what
// this means when a v1 and v2 marker for "the same" underlying finding both
// exist on one PR: they carry different hashes and are NOT linked — no
// retroactive matching is attempted, each version's findings only dedup
// against findings of the same version going forward.
//
// Deliberately END-ANCHORED / LAST-MATCH, not first-match (design doc's
// review-amendment #2), regardless of which version matches last.
// formatFindingBody always appends its marker as the very last thing in the
// body, so if attacker-controlled finding text (summary/description/
// suggestion — LLM output shaped by diff content) smuggles fake marker
// syntax earlier in the body despite sanitizeForComment, the real marker GSR
// appended is still the one this function recovers. Taking the first match
// would be exactly backwards.
export function parseFindingMarker(body: string): FindingMarker | null {
  if (!body) return null;
  // Self-review finding: a lazy [\s\S]*? scan with no closing "-->" ever
  // present is O(N²) — each of M starting positions ("<!-- gsr:v1 "
  // prefixes) with no match ahead scans to the end of the string before
  // failing (verified empirically: ~725ms at 288KB of stacked unclosed
  // markers, scaling quadratically). Not reachable via GSR's own posting
  // path today — encodeField's encodeURIComponent means a legitimate
  // marker's fields never contain raw "<"/">", and sanitizeForComment
  // already strips every "<!--"/"-->" from finding text before the real
  // marker is appended, so a GSR-posted comment can contain at most one
  // delimited span — but restricting the capture group to [^<>] is safe
  // for that same reason (real markers never contain those characters)
  // and bounds the worst case to O(N) regardless, defense-in-depth against
  // either invariant changing later.
  //
  // Self-review finding (confirmed by benchmark, not just theoretical):
  // `\s+` directly followed by `[^<>]*?` overlap on whitespace — both can
  // match a space — so on an unclosed marker made of a long whitespace run
  // (e.g. "<!-- gsr:v1" + 64KB of spaces, no "-->" anywhere), the engine
  // backtracks `\s+` one character at a time and re-scans the remainder
  // with `[^<>]*?` at each step: ~1.2s at 64KB, scaling quadratically
  // (confirmed empirically: 4x the input consistently costs ~4x² the time).
  // `\s` (exactly one, not one-or-more) removes the overlap — any
  // additional whitespace is still captured by `[^<>]*?` right after, so a
  // real multi-space-separated marker parses identically (parseMarkerFields
  // trims the captured group before splitting on fields) — while a
  // 512KB adversarial unclosed run now finishes in under a millisecond.
  const pattern = /<!--\s*gsr:(v1|v2)\s([^<>]*?)-->/g;
  let match: RegExpExecArray | null;
  let lastValid: FindingMarker | null = null;
  while ((match = pattern.exec(body)) !== null) {
    const parsed = parseMarkerFields(match[2], match[1] as 'v1' | 'v2');
    if (parsed) lastValid = parsed;
  }
  return lastValid;
}

// --- Reply marker build/parse (Phase 2) ---

const VALID_VERDICTS = new Set<AdjudicationVerdict>(['pushback_correct', 'pushback_incorrect', 'unclear']);

// buildReplyMarker renders the marker appended to every rebuttal GSR posts.
// Callers must sanitize/truncate the reply BODY before appending this (same
// last-appended-wins contract as buildFindingMarker) — this function only
// renders the marker's own fields, all percent-encoded per encodeField.
export function buildReplyMarker(marker: Omit<ReplyMarker, 'version'>): string {
  const parts = [
    `f=${encodeField(marker.findingId)}`,
    `round=${marker.round}`,
    `verdict=${encodeField(marker.verdict)}`,
    `conf=${marker.confidence.toFixed(2)}`,
    `ack=${marker.ackCommentId}`,
  ];
  return `<!-- gsr-reply:v1 ${parts.join(' ')} -->`;
}

function parseReplyMarkerFields(raw: string): ReplyMarker | null {
  const fields: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    fields[key] = decodeField(token.slice(eq + 1));
  }

  if (!fields.f || !/^[0-9a-f]+$/i.test(fields.f)) return null;

  const round = Number(fields.round);
  if (!Number.isInteger(round) || round < 1) return null;

  if (!fields.verdict || !VALID_VERDICTS.has(fields.verdict as AdjudicationVerdict)) return null;

  // PR #61 self-review finding: Number('') is 0, a finite, valid-looking
  // integer — so a truncated/malformed marker with an empty `conf=` or
  // `ack=` token would otherwise silently coerce to 0 and pass validation,
  // rather than being rejected as the malformed field it actually is.
  // `round`'s own `< 1` check already catches this for that field (0 fails
  // it), but conf/ack both accept 0 as a legitimate value, so they need an
  // explicit presence check first.
  if (!fields.conf) return null;
  const confidence = Number(fields.conf);
  if (!Number.isFinite(confidence)) return null;

  if (!fields.ack) return null;
  const ackCommentId = Number(fields.ack);
  if (!Number.isInteger(ackCommentId) || ackCommentId < 0) return null;

  return {
    version: 'v1',
    findingId: fields.f,
    round,
    verdict: fields.verdict as AdjudicationVerdict,
    confidence: Math.max(0, Math.min(1, confidence)),
    ackCommentId,
  };
}

// parseReplyMarker mirrors parseFindingMarker exactly: end-anchored /
// last-match-wins, restricted to a `[^<>]` capture group for the same O(N)
// ReDoS-safety reason, and `\s` (not `\s+`) right before that group for the
// same overlapping-quantifier reason (see parseFindingMarker's comment).
// Returns null on ANY malformed field OR when there is no marker at all —
// callers must NOT treat a null result as "GSR never replied here" (that
// would be fail-OPEN: a format drift or parser bug would silently re-enable
// a second rebuttal). github.ts's deriveGsrLastReply treats every null
// uniformly — a trusted-login reply with no marker and one with a broken
// marker both fail closed the same way, so no separate presence-only check
// is needed here.
export function parseReplyMarker(body: string): ReplyMarker | null {
  if (!body) return null;
  const pattern = /<!--\s*gsr-reply:v1\s([^<>]*?)-->/g;
  let match: RegExpExecArray | null;
  let lastValid: ReplyMarker | null = null;
  while ((match = pattern.exec(body)) !== null) {
    const parsed = parseReplyMarkerFields(match[1]);
    if (parsed) lastValid = parsed;
  }
  return lastValid;
}

// stripMarkers removes every gsr:v1 / gsr:v2 / gsr-reply:v1 marker comment
// from a body, GLOBALLY — not just a trailing one. A GSR-authored body has
// its marker trailing by construction (formatFindingBody / the reply
// builder always append it last), but an edited comment might not, and this
// is used to build clean context for the adjudicator prompt (design doc
// §8.3 item 1: "description and suggestion from the root comment body") — a
// stray non-trailing marker fragment leaking into that context costs
// nothing to also strip. Same restricted [^<>] capture group as the parsers
// above, for the same ReDoS-safety reason, and `\s` (not `\s+`) for the same
// overlapping-quantifier reason.
//
// Self-review finding: grouping `(?:-reply)?` together with `(?:v1|v2)`
// (i.e. `gsr(?:-reply)?:(?:v1|v2)`) also matches the never-generated
// `gsr-reply:v2` — reply markers are only ever built as `gsr-reply:v1`
// (buildReplyMarker), so the two prefixes are alternated strictly instead
// of factored together, matching only the three formats that actually
// exist.
const MARKER_STRIP_PATTERN = /<!--\s*(?:gsr:(?:v1|v2)|gsr-reply:v1)\s[^<>]*?-->/g;
export function stripMarkers(body: string): string {
  if (!body) return body;
  return body.replace(MARKER_STRIP_PATTERN, '').trim();
}

// --- Legacy (pre-marker) findings ---
//
// Threads created before markers shipped have no `f=`. This regexes
// github.ts's existing formatFindingBody rendering
// (`emoji **SEVERITY** · agent — summary`) off the first line to recover
// enough to compute a findingId for. If this fails, the caller should skip
// the thread entirely rather than guess (design doc §4.3).
const LEGACY_BODY_PATTERN = /^(?:[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F535}]\s*)?\*\*(CRITICAL|HIGH|MEDIUM|LOW)\*\*(?:\s*·\s*(.+?))?\s*—\s*(.+)$/u;

export function parseLegacyFindingBody(body: string): LegacyFindingInfo | null {
  if (!body) return null;
  // Self-review finding: trimming only the extracted first line doesn't
  // help when the body starts with a blank line — `split('\n', 1)[0]` on
  // "\n**HIGH**..." yields "" before any trimming happens. Trim the whole
  // body first so a leading blank line can't hide the real header line.
  const firstLine = body.trim().split('\n', 1)[0]?.trim();
  if (!firstLine) return null;
  const match = LEGACY_BODY_PATTERN.exec(firstLine);
  if (!match) return null;
  return { severity: match[1], agent: match[2]?.trim(), summary: match[3].trim() };
}
