import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_LOW_PRIORITY_PATH_PATTERNS,
  globToRegExp,
  parseLowPriorityPathPatterns,
  isLowPriorityPath,
} from '../src/lowPriorityPaths';

describe('lowPriorityPaths', () => {
  describe('DEFAULT_LOW_PRIORITY_PATH_PATTERNS', () => {
    it('matches the review-quality-design.md §4 job_tracker audit examples', () => {
      expect(isLowPriorityPath('design_prd/recruiter_pm_leader_tracker_artifact.html', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
      expect(isLowPriorityPath('wait_for_app.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
      expect(isLowPriorityPath('run_real_test.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
      expect(isLowPriorityPath('some/page.mockup.html', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(true);
    });

    it('does not match ordinary shipping code, including a root-level .go/.ts file', () => {
      expect(isLowPriorityPath('internal/api/handler.go', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('main.go', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('index.ts', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
    });

    it('does not match a shell script that lives under a subdirectory (only root-level scripts are low-priority)', () => {
      expect(isLowPriorityPath('scripts/deploy.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
      expect(isLowPriorityPath('bin/run.sh', DEFAULT_LOW_PRIORITY_PATH_PATTERNS)).toBe(false);
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

      // ...and must stay fast against an adversarial non-matching string
      // that would take ~1.8s uncollapsed (verified manually during
      // security-review). 1000ms leaves generous headroom for CI scheduling
      // noise/GC pauses (self-review finding: a 200ms ceiling risked
      // flaking on a loaded runner) while still reliably catching a
      // regression back to the uncollapsed, exponential-backtracking form —
      // that form takes seconds, not milliseconds, so this ceiling loses no
      // real detection power.
      const adversarial = 'a/'.repeat(35) + 'b';
      const start = Date.now();
      expect(re.test(adversarial)).toBe(false);
      expect(Date.now() - start).toBeLessThan(1000);
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
      expect(isLowPriorityPath('wait_for_app.sh', patterns)).toBe(true);
    });

    it('trims whitespace and drops empty entries from the comma-separated list', () => {
      const patterns = parseLowPriorityPathPatterns(' scratch/** , , *.debug.ts ');
      expect(isLowPriorityPath('scratch/notes.md', patterns)).toBe(true);
      expect(isLowPriorityPath('helper.debug.ts', patterns)).toBe(true);
    });
  });
});
