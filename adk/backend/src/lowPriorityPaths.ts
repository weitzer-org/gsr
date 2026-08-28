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
//
// An earlier version of this function only collapsed "**" segments that
// were already cleanly slash-delimited, which GSR's own self-review swarm
// caught as incomplete: "****" (one run of 4+ stars, no slash at all) or
// "**//**" (an empty segment from a doubled slash) both bypassed it and
// still compiled to the same dangerous adjacent-group shape. Confirmed
// directly: "****" alone, uncollapsed, took ~28s to reject a 71-byte
// adversarial string — worse than the original 8-group case, since a
// single character typo (one extra "*") triggers it. Fixed by normalizing
// star-runs and slash-runs to their canonical single/double form *before*
// segment-splitting, so every way of writing "repeated wildcard" reduces to
// the same collapsible shape instead of enumerating bypasses one at a time.
function normalizeGlobRuns(glob: string): string {
  return glob.replace(/\*{2,}/g, '**').replace(/\/{2,}/g, '/');
}

function collapseRepeatedGlobstars(glob: string): string {
  const segments = normalizeGlobRuns(glob).split('/');
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

// Root-level "*.sh" was in this list originally (matching the two job_tracker
// scratch-script fixture entries, wait_for_app.sh / run_real_test.sh) but
// was removed after a self-review security finding: build.sh/deploy.sh/
// setup.sh are common, genuinely security-sensitive CI/CD entry points at
// repo root, and since low-priority-paths is additive-only (a consuming repo
// can't opt OUT of a built-in default — see the module doc above), a
// blanket root-level-script default would have silently weakened
// fail-on-severity's security gate for every consumer with no way to
// disable it, for the sake of two scratch scripts in one repo. Left as a
// suggested opt-in in the low-priority-paths Action input's own
// documentation instead of a built-in default — see action.yml.
const DEFAULT_LOW_PRIORITY_GLOBS = [
  'design_prd/**',
  '**/*.mockup.html',
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
