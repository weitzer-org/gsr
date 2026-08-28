// review-quality-design.md §4/§4.1 (Gap 3): findings on non-shipping content
// (static design mockups, one-off scratch scripts) were reviewed at full
// severity, same as internal/*.go. This is a post-hoc severity *dampening*
// mechanism, not exclusion (unlike github.ts's IGNORE_PATTERNS) — these
// files can contain real bugs, just low-stakes ones, so they still get
// reviewed and posted, just capped below CRITICAL/HIGH. See
// orchestrator.ts's filterFindings for where this is applied.
//
// Built-in defaults always apply; an Action input (`low-priority-paths`,
// comma-separated globs) EXTENDS them — it can never disable a default,
// only add repo-specific patterns on top. This avoids a config mistake in
// one consuming repo silently reopening the gap for every other consumer.

// Minimal glob support: "**/" matches zero or more leading path segments
// (so "**/*.x" also matches "*.x" at the root, the common convention),
// "/**" matches one or more trailing segments, a standalone "**" matches
// anything, "*" matches within a single path segment. Sufficient for the
// path-prefix/suffix/extension patterns this feature needs without adding a
// glob-matching dependency. Single-pass token-by-token translation via a
// replacer callback, so glob-token recognition and literal-character
// escaping happen together instead of in separate passes that could
// clobber each other.
// The `?` in the escape class matters, not just cosmetically: `?` is a
// regex quantifier, so a glob containing a literal "?" (e.g. "file?.txt")
// left unescaped either silently changes matching semantics (the preceding
// character becomes optional) or — if "?" has nothing valid to quantify,
// e.g. a glob starting with "?" — throws "Invalid regular expression:
// Nothing to repeat" and crashes the Action on an otherwise-plausible
// low-priority-paths config (self-review finding, confirmed both failure
// modes directly before fixing).
const GLOB_TOKEN = /\*\*\/|\/\*\*|\*\*|\*|[.+^${}()|[\]?\\]/g;

// Collapses consecutive "**" path segments ("a/**/**/b" -> "a/**/b") before
// tokenizing. Semantically lossless — "**" already means "zero or more
// segments," so repeating it adds nothing — but load-bearing for safety:
// left uncollapsed, N adjacent "**" tokens compile to N adjacent unanchored
// (?:.*/)? groups, a textbook catastrophic-backtracking (ReDoS) shape.
// Confirmed directly: 8 adjacent "**" groups took ~1.8s to reject a 71-byte
// non-matching string; since `file` (tested against these patterns in
// orchestrator.ts) traces back to attacker-controlled PR diff filenames,
// an accidentally-doubled "**" in a low-priority-paths config (an easy
// templating/copy-paste mistake, not an exotic one) would let any external
// contributor hang the review Action with a crafted filename.
function collapseRepeatedGlobstars(glob: string): string {
  const segments = glob.split('/');
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '**' && collapsed[collapsed.length - 1] === '**') continue;
    collapsed.push(segment);
  }
  return collapsed.join('/');
}

export function globToRegExp(glob: string): RegExp {
  const pattern = collapseRepeatedGlobstars(glob).replace(GLOB_TOKEN, (token) => {
    if (token === '**/') return '(?:.*/)?';
    if (token === '/**') return '(?:/.*)?';
    if (token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return '\\' + token; // literal regex-special character
  });

  return new RegExp('^' + pattern + '$', 'i');
}

const DEFAULT_LOW_PRIORITY_GLOBS = [
  'design_prd/**',
  '**/*.mockup.html',
  // Root-level scripts only ("*" doesn't cross "/") — a script under
  // scripts/, bin/, cmd/, etc. implies deliberate placement and isn't
  // covered. Deliberately narrow per design doc §9 open question 3 ("worth
  // validating against at least one more consuming repo before hardcoding
  // defaults") — consuming repos extend this list for their own
  // scratch-tooling conventions via the low-priority-paths input.
  '*.sh',
];

export const DEFAULT_LOW_PRIORITY_PATH_PATTERNS: RegExp[] = DEFAULT_LOW_PRIORITY_GLOBS.map(globToRegExp);

// Parses the comma-separated `low-priority-paths` Action input into
// RegExp[], always prepending the built-in defaults (see module doc above —
// additive, not replacing).
export function parseLowPriorityPathPatterns(csv: string | undefined): RegExp[] {
  if (!csv || !csv.trim()) return DEFAULT_LOW_PRIORITY_PATH_PATTERNS;
  const custom = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegExp);
  return [...DEFAULT_LOW_PRIORITY_PATH_PATTERNS, ...custom];
}

export function isLowPriorityPath(file: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(file));
}
