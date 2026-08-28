import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_LOW_PRIORITY_PATH_PATTERNS,
  globToRegExp,
  parseLowPriorityPathPatterns,
  isLowPriorityPath,
} from '../src/lowPriorityPaths';

describe('lowPriorityPaths', () => {
  describe('DEFAULT_LOW_PRIORITY_PATH_PATTERNS', () => {
    it('matches the review-quality-design.md §4 job_tracker audit examples that are still built-in defaults', () => {
      expect(isLowPriorityPath('design_prd/recruiter_pm_leader_tracker_artifact.html', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
      expect(isLowPriorityPath('some/page.mockup.html', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
    });

    it('does NOT match root-level shell scripts by default (self-review security finding: build.sh/deploy.sh/setup.sh are common CI/CD entry points; a repo can opt in to a narrower pattern via low-priority-paths instead)', () => {
      expect(isLowPriorityPath('wait_for_app.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('run_real_test.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('deploy.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
    });

    it('does not match ordinary shipping code, including a root-level .go/.ts file', () => {
      expect(isLowPriorityPath('internal/api/handler.go', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('main.go', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('index.ts', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
    });
  });

  describe('globToRegExp', () => {
    it('translates "**" into a cross-segment wildcard', () => {
      const re = globToRegExp('design_prd/**');
      expect(re.test('design_prd/a.html')).toBe(true);
      expect(re.test('design_prd/nested/b.html')).toBe(true);
      expect(re.test('other/design_prd/a.html')).toBe(false);
    });

    it('translates a leading "**/" prefix so it also matches at the root', () => {
      const re = globToRegExp('**/*.mockup.html');
      expect(re.test('page.mockup.html')).toBe(true);
      expect(re.test('deep/nested/page.mockup.html')).toBe(true);
    });

    it('translates "*" as a single-segment wildcard that does not cross "/"', () => {
      const re = globToRegExp('*.sh');
      expect(re.test('run.sh')).toBe(true);
      expect(re.test('scripts/run.sh')).toBe(false);
    });

    it('escapes regex-special characters in literal glob segments', () => {
      const re = globToRegExp('a.b+c/*.txt');
      expect(re.test('a.b+c/file.txt')).toBe(true);
      expect(re.test('aXbXc/file.txt')).toBe(false);
    });

    it('escapes a literal "?" instead of treating it as a quantifier (self-review finding: unescaped "?" either silently changes matching or throws)', () => {
      const re = globToRegExp('file?.txt');
      expect(re.test('file?.txt')).toBe(true);
      expect(re.test('file.txt')).toBe(false); // would wrongly match if "?" quantified the "e"

      expect(() => globToRegExp('?foo.txt')).not.toThrow();
      expect(globToRegExp('?foo.txt').test('?foo.txt')).toBe(true);
    });

    it('collapses consecutive "**" segments instead of compiling adjacent unanchored wildcards (ReDoS guard, security-review finding)', () => {
      const re = globToRegExp('**/**/**/**/**/**/**/**/x.never');
      // Semantically equivalent to a single "**" — collapsing must not
      // change matching behavior for legitimate input...
      expect(re.test('a/b/c/x.never')).toBe(true);
      expect(re.test('x.never')).toBe(true);
      expect(re.test('a/b/c/y.never')).toBe(false);

      // ...and must not hang on an adversarial non-matching string that
      // took ~1.8s uncollapsed (verified manually during security-review).
      // Deliberately no Date.now()/toBeLessThan assertion here (an earlier
      // version had one, first at 200ms then widened to 1000ms) — a
      // self-review finding correctly pointed out that's still a flaky
      // time-bound assertion under CI scheduling noise, and unnecessary:
      // if catastrophic backtracking is reintroduced it hangs for seconds
      // to minutes, so Jest's own default 5000ms test timeout is a
      // sufficient, zero-flakiness regression guard on its own.
      const adversarial = 'a/'.repeat(35) + 'b';
      expect(re.test(adversarial)).toBe(false);
    });

    it('also guards against a run of 3+ literal "*" with no slash, and an empty segment from a doubled "/" (self-review finding: these bypassed the first version of the collapse fix)', () => {
      // "****" has no "/" at all, so a naive slash-segment collapse never
      // sees it as two "**" segments to merge — confirmed this bypassed an
      // earlier version of the fix and took ~28s to reject a 71-byte
      // adversarial string, worse than the original multi-"**/" case since
      // a single extra "*" typo triggers it.
      const quad = globToRegExp('****/****/****/****/x.never');
      expect(quad.test('a/b/x.never')).toBe(true);
      expect(quad.test('x.never')).toBe(true);
      expect(quad.test('a/b/y.never')).toBe(false);

      // "**//**" splits into ['**', '', '**'] — the empty middle segment
      // means neither "**" is immediately adjacent to the other by the
      // original segment-equality check, so it also bypassed collapsing.
      // Anchored with a literal suffix (unlike a bare "**//**", which
      // collapses to match-anything and so has no non-matching adversarial
      // case to test hang-safety against).
      const doubleSlash = globToRegExp('**//**/x.never');
      expect(doubleSlash.test('a/b/x.never')).toBe(true);
      expect(doubleSlash.test('a/b/y.never')).toBe(false);

      // Same rationale as above for hanging (no timing assertion — Jest's
      // default test timeout is the regression guard for that) — but the
      // match result itself still needs asserting, or a regex that
      // compiles to something that wrongly matches the adversarial string
      // would pass silently (self-review finding, correct catch).
      const adversarial = 'a/'.repeat(35) + 'b';
      for (const re of [quad, doubleSlash]) {
        expect(re.test(adversarial)).toBe(false);
      }
    });
  });

  describe('parseLowPriorityPathPatterns', () => {
    it('returns only the defaults when no custom input is given', () => {
      expect(parseLowPriorityPathPatterns(undefined)).toBe(DEFAULT_LOW_PRIORITY_PATH_PATTERNS);
      expect(parseLowPriorityPathPatterns('')).toBe(DEFAULT_LOW_PRIORITY_PATH_PATTERNS);
      expect(parseLowPriorityPathPatterns('   ')).toBe(DEFAULT_LOW_PRIORITY_PATH_PATTERNS);
    });

    it('EXTENDS the defaults with custom globs rather than replacing them (a consuming repo cannot disable the defaults)', () => {
      const patterns = parseLowPriorityPathPatterns('scratch/**,*.debug.ts');

      // A custom repo-specific path is now low-priority...
      expect(isLowPriorityPath('scratch/notes.md', patterns)).toBe(true);
      expect(isLowPriorityPath('helper.debug.ts', patterns)).toBe(true);
      // ...and the built-in defaults still apply.
      expect(isLowPriorityPath('design_prd/mockup.html', patterns)).toBe(true);
    });

    it('lets a repo opt into root-level "*.sh" dampening explicitly, since it is not a built-in default', () => {
      expect(isLowPriorityPath('wait_for_app.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);

      const withOptIn = parseLowPriorityPathPatterns('*.sh');
      expect(isLowPriorityPath('wait_for_app.sh', withOptIn)).toBe(true);
    });

    it('trims whitespace and drops empty entries from the comma-separated list', () => {
      const patterns = parseLowPriorityPathPatterns(' scratch/** , , *.debug.ts ');
      expect(isLowPriorityPath('scratch/notes.md', patterns)).toBe(true);
      expect(isLowPriorityPath('helper.debug.ts', patterns)).toBe(true);
    });
  });
});
