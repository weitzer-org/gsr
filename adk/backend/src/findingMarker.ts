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
import { CandidateFinding } from './types';

export interface FindingMarker {
  version: 'v1';
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

// --- findingId ---
//
// Reuses finding-feedback-requirements.md §5.3's scheme unchanged — the same
// hash review-quality-design.md §2.1 already committed to for
// repeat-suppression, so this is deliberately the third consumer of one
// identity decision rather than a fourth invented one.
//
// Known limitation, accepted (per that doc): `summary` is LLM-generated and
// isn't guaranteed byte-stable across two runs that "found the same thing",
// so this is a best-effort correlation key, not a foreign key. This feature
// is less exposed to that weakness than the push-based one, though: it reads
// the id back out of a marker already written into the thread rather than
// recomputing and hoping for a match.
export function computeFindingId(input: { file: string; line: number; agent?: string; summary: string }): string {
  const key = `${input.file}|${input.line}|${input.agent || ''}|${input.summary}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// findingIdFor is a small convenience wrapper so call sites can pass a
// CandidateFinding directly without restating its four fields.
export function findingIdFor(finding: Pick<CandidateFinding, 'file' | 'line' | 'agent' | 'summary'>): string {
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
export function sanitizeForComment(text: string): string {
  if (!text) return text;

  // Self-review finding (independently flagged CRITICAL/HIGH by both the
  // swarm and basic passes): a single non-idempotent replace pass is
  // bypassable by nesting \u2014 e.g. "<!" + "<!--" + "--" contains no "<!--" or
  // "-->" match spanning the outer fragments, but removing the inner
  // "<!--" (the only match found) leaves the surrounding "<!" and "--"
  // adjacent, reforming "<!--". Loop to a fixed point so no removal can
  // ever expose a fresh match. Provably terminates: each iteration either
  // leaves the string unchanged (loop exits) or strictly shortens it, so
  // the iteration count is bounded by text.length.
  let out = text;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<!--/g, '').replace(/-->/g, '');
  } while (out !== previous);

  // Self-review finding: matching "@" + word-char unconditionally also
  // corrupts legitimate email addresses in finding text (e.g.
  // "hardcoded credential for admin@example.com" becomes
  // "admin@\u200Bexample.com"). Only treat it as a mention to neutralize
  // when the "@" isn't already embedded in a word/dotted/hyphenated
  // token \u2014 real @mentions are preceded by whitespace or start-of-string.
  out = out.replace(/(?<![\w.-])@(\w)/g, '@\u200B$1');
  return out;
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
// sites don't all need to thread a timestamp through.
export function buildFindingMarker(marker: Omit<FindingMarker, 'version'>): string {
  const parts = [`f=${encodeField(marker.findingId)}`];
  if (marker.agent) parts.push(`a=${encodeField(marker.agent)}`);
  if (marker.severity) parts.push(`s=${encodeField(marker.severity)}`);
  if (marker.promptVersion) parts.push(`pv=${encodeField(marker.promptVersion)}`);
  parts.push(`r=${encodeField(marker.createdAt || new Date().toISOString())}`);
  return `<!-- gsr:v1 ${parts.join(' ')} -->`;
}

function parseMarkerFields(raw: string): FindingMarker | null {
  const fields: Record<string, string> = {};
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) continue; // no '=' or empty key — malformed token, ignored (unknown/bad keys don't invalidate the rest)
    const key = token.slice(0, eq);
    fields[key] = decodeField(token.slice(eq + 1));
  }
  // f= is the only required field, and must look like a hex hash — anything
  // else means this isn't really a gsr:v1 marker, well-formed HTML comment
  // syntax notwithstanding.
  if (!fields.f || !/^[0-9a-f]+$/i.test(fields.f)) return null;
  return {
    version: 'v1',
    findingId: fields.f,
    agent: fields.a,
    severity: fields.s,
    promptVersion: fields.pv,
    createdAt: fields.r,
  };
}

// parseFindingMarker extracts GSR's finding marker from a comment body.
//
// Deliberately END-ANCHORED / LAST-MATCH, not first-match (design doc's
// review-amendment #2). formatFindingBody always appends its marker as the
// very last thing in the body, so if attacker-controlled finding text
// (summary/description/suggestion — LLM output shaped by diff content)
// smuggles fake marker syntax earlier in the body despite
// sanitizeForComment, the real marker GSR appended is still the one this
// function recovers. Taking the first match would be exactly backwards.
export function parseFindingMarker(body: string): FindingMarker | null {
  if (!body) return null;
  const pattern = /<!--\s*gsr:v1\s+([\s\S]*?)-->/g;
  let match: RegExpExecArray | null;
  let lastValid: FindingMarker | null = null;
  while ((match = pattern.exec(body)) !== null) {
    const parsed = parseMarkerFields(match[1]);
    if (parsed) lastValid = parsed;
  }
  return lastValid;
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
  const firstLine = body.split('\n', 1)[0]?.trim();
  if (!firstLine) return null;
  const match = LEGACY_BODY_PATTERN.exec(firstLine);
  if (!match) return null;
  return { severity: match[1], agent: match[2]?.trim(), summary: match[3].trim() };
}
