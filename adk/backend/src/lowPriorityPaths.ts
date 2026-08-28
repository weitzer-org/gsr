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

// A compiled low-priority-path pattern. Deliberately NOT `RegExp` — see the
// history below for why — but a real `RegExp` also satisfies this shape
// (it has a `.test(string): boolean` method), so existing callers/tests
// that pass a raw regex literal (e.g. in a custom pattern list) keep
// working unchanged.
export interface PathPattern {
  test(file: string): boolean;
}

// --- History: this used to compile globs to a backtracking RegExp, and it
// took three rounds of GSR's own self-review to find out why that's
// structurally unsafe, not just buggy in specific spots:
//
// Round 1 translated each "*"/"**" token to a regex fragment independently
// ("*" -> "[^/]*", "**" -> ".*"), which is fine for one wildcard but
// compiles adjacent wildcards (a glob with repeated "**" segments, e.g. an
// accidentally-doubled "**/**/*.log") into adjacent unanchored regex
// groups — textbook catastrophic backtracking. Confirmed: 8 adjacent "**"
// groups took ~1.8s to reject a 71-byte adversarial string.
//
// Round 2's fix (collapsing consecutive "**" segments before tokenizing)
// only handled cleanly slash-delimited repeats. "****" (one run of stars,
// no slash) or "**//**" (an empty segment from a doubled slash) bypassed
// it and hit the same shape — "****" alone took ~28s.
//
// Round 3 (this version) is not another bypass patch: CodeRabbit's review
// found that even a single "*" per position is unsafe once there are
// several of them separated by literal text with no "**" involved at all
// — e.g. "*a*a*a*a*a*a*a*aZ" compiles to "[^/]*a[^/]*a[^/]*a...", the
// classic `(x*)+y`-shaped ReDoS. Confirmed directly: 10 such wildcard/
// literal pairs took ~15s to reject an adversarial filename; 12 didn't
// finish in over two minutes. That's not a bypass of the round-2 fix,
// it's a fundamentally different vulnerability in the whole "compile to a
// backtracking regex" strategy — no amount of collapsing repeated tokens
// fixes it, because the ambiguity is between *any* two wildcards
// separated by literal text, adjacent or not.
//
// The actual fix: don't build a backtracking RegExp at all. Match glob
// segments against path segments using the classic linear-time wildcard
// algorithm (the standard solution to "Wildcard Matching", e.g. LeetCode
// 44) — a single forward pass with one remembered backtrack point, O(n*m)
// worst case, never exponential, because there is no recursive branching
// to blow up. Applied at two levels: path segments against each other
// (a "**" segment matches zero or more whole segments), and, within a
// non-"**" segment, characters against each other ("*" matches zero or
// more characters, never crossing the "/" that already separates
// segments). Every other character (including "?", ".", "+", etc.) is a
// plain literal compared directly — there's no regex construction left
// anywhere in this file, so there's also no more "did I escape this
// regex-special character" class of bug (the "?"-escaping bug from round
// 1 is structurally impossible now, not just fixed).

const GLOBSTAR = '**';

// Linear-time wildcard match ("*" = zero or more of anything) between two
// arrays of tokens, using an equality predicate for non-wildcard
// comparisons. Shared by both matching levels below (segments-of-a-path
// and characters-of-a-segment) so there's one implementation of the
// non-backtracking algorithm to get right, not two.
function wildcardMatch<T>(pattern: ArrayLike<T>, input: ArrayLike<T>, isWildcard: (t: T) => boolean, equals: (a: T, b: T) => boolean): boolean {
  let p = 0;
  let i = 0;
  let starP = -1;
  let starI = 0;

  while (i < input.length) {
    if (p < pattern.length && (isWildcard(pattern[p]) || equals(pattern[p], input[i]))) {
      if (isWildcard(pattern[p])) {
        starP = p;
        starI = i;
        p++;
      } else {
        p++;
        i++;
      }
    } else if (starP !== -1) {
      p = starP + 1;
      starI++;
      i = starI;
    } else {
      return false;
    }
  }

  while (p < pattern.length && isWildcard(pattern[p])) p++;
  return p === pattern.length;
}

function matchSegment(patternSegment: string, fileSegment: string): boolean {
  // Strings are natively ArrayLike<string> (index access + .length), so
  // wildcardMatch can operate on them directly — no .split('') array
  // allocation needed. Both arguments are already lowercased by the
  // caller (compileGlob lowercases pattern segments once, at compile
  // time; test() lowercases file segments once per call) rather than
  // here — .toLowerCase() still allocates a new string even with no
  // .split(), and this inner comparison can run many times per outer
  // segment-level backtrack (self-review finding: re-lowercasing on every
  // one of those retries was exactly the allocation the .split() fix
  // above was supposed to eliminate).
  return wildcardMatch(patternSegment, fileSegment, (c) => c === '*', (a, b) => a === b);
}

export function compileGlob(glob: string): PathPattern {
  const patternSegments = glob.toLowerCase().split('/');
  return {
    test(file: string): boolean {
      const fileSegments = file.toLowerCase().split('/');
      return wildcardMatch(
        patternSegments,
        fileSegments,
        (seg) => seg === GLOBSTAR,
        (patternSeg, fileSeg) => matchSegment(patternSeg, fileSeg)
      );
    },
  };
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

export const DEFAULT_LOW_PRIORITY_PATH_PATTERNS: PathPattern[] = DEFAULT_LOW_PRIORITY_GLOBS.map(compileGlob);

// Parses the comma-separated `low-priority-paths` Action input into
// PathPattern[], always prepending the built-in defaults (see module doc
// above — additive, not replacing).
export function parseLowPriorityPathPatterns(csv: string | undefined): PathPattern[] {
  if (!csv || !csv.trim()) return DEFAULT_LOW_PRIORITY_PATH_PATTERNS;
  const custom = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(compileGlob);
  return [...DEFAULT_LOW_PRIORITY_PATH_PATTERNS, ...custom];
}

export function isLowPriorityPath(file: string, patterns: PathPattern[]): boolean {
  return patterns.some((pattern) => pattern.test(file));
}
