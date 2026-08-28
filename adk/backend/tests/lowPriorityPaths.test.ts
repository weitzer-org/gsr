import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_LOW_PRIORITY_PATH_PATTERNS,
  compileGlob,
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

  describe('compileGlob', () => {
    it('translates "**" into a cross-segment wildcard', () => {
      const re = compileGlob('design_prd/**');
      expect(re.test('design_prd/a.html')).toBe(true);
      expect(re.test('design_prd/nested/b.html')).toBe(true);
      expect(re.test('other/design_prd/a.html')).toBe(false);
    });

    it('translates a leading "**/" prefix so it also matches at the root', () => {
      const re = compileGlob('**/*.mockup.html');
      expect(re.test('page.mockup.html')).toBe(true);
      expect(re.test('deep/nested/page.mockup.html')).toBe(true);
    });

    it('translates "*" as a single-segment wildcard that does not cross "/"', () => {
      const re = compileGlob('*.sh');
      expect(re.test('run.sh')).toBe(true);
      expect(re.test('scripts/run.sh')).toBe(false);
    });

    it('matches non-wildcard characters literally, case-insensitively', () => {
      const re = compileGlob('a.b+c/*.txt');
      expect(re.test('a.b+c/file.txt')).toBe(true);
      expect(re.test('A.B+C/FILE.TXT')).toBe(true);
      expect(re.test('aXbXc/file.txt')).toBe(false);
    });

    it('treats "?" as a plain literal character, not a wildcard (there is no regex construction at all, so no escaping is needed and no glob can crash this function)', () => {
      const re = compileGlob('file?.txt');
      expect(re.test('file?.txt')).toBe(true);
      expect(re.test('file.txt')).toBe(false);

      expect(() => compileGlob('?foo.txt')).not.toThrow();
      expect(compileGlob('?foo.txt').test('?foo.txt')).toBe(true);
    });

    describe('ReDoS safety (three real vulnerabilities found across GSR self-review rounds on this feature — history in the module doc)', () => {
      // All three rounds found real, verified-not-theoretical catastrophic
      // backtracking in a regex-based implementation of this function:
      //   1. Adjacent "**" segments (e.g. "**/**/**/...") — 8 groups took
      //      ~1.8s to reject a 71-byte adversarial string.
      //   2. "****" (a star-run with no slash) or "**//**" (an empty
      //      segment from a doubled slash) — "****" alone took ~28s.
      //   3. CodeRabbit: non-adjacent single "*" tokens separated by
      //      literal text (e.g. "*a*a*a*a*a*a*a*a*a*aZ") — 10 such pairs
      //      took ~15s, 12 didn't finish in over two minutes.
      // compileGlob no longer builds a RegExp at all (see module doc), so
      // none of these are bypasses of a patch anymore — they're
      // regression tests confirming the linear-time matcher handles every
      // known-dangerous shape without hanging, checked here in well under
      // Jest's default 5000ms test timeout (no explicit timing assertion,
      // per a self-review finding: a tight threshold is CI-flaky and
      // unnecessary — a reintroduced backtracking regex would hang for
      // seconds to minutes, so the test timeout alone is sufficient).
      it('adjacent "**" segments', () => {
        const re = compileGlob('**/**/**/**/**/**/**/**/x.never');
        expect(re.test('a/b/c/x.never')).toBe(true);
        expect(re.test('x.never')).toBe(true);
        expect(re.test('a/b/c/y.never')).toBe(false);
        expect(re.test('a/'.repeat(35) + 'b')).toBe(false);
      });

      it('a run of 3+ "*" with no slash, and an empty segment from a doubled "/"', () => {
        // "****" is a segment containing 4 literal "*" characters, not the
        // special "**" token (that requires the whole segment to be
        // exactly "**") — so, unlike the old regex-based "**" collapsing,
        // it means "match within this one segment" (same as "*"), not
        // "any depth". Each of the 4 "****" segments must correspond to
        // exactly one file segment.
        const quad = compileGlob('****/****/****/****/x.never');
        expect(quad.test('a/b/c/d/x.never')).toBe(true);
        expect(quad.test('a/b/c/d/y.never')).toBe(false);
        expect(quad.test('a/'.repeat(35) + 'b')).toBe(false); // wrong segment count — must reject, not hang

        // "**//**/x.never" splits into ['**', '', '**', 'x.never'] — the
        // empty middle segment only matches a file with a literal empty
        // path segment (e.g. from a real "//" in the filename), which is
        // unusual but not what matters here: the point is it must not hang.
        const doubleSlash = compileGlob('**//**/x.never');
        expect(doubleSlash.test('a//x.never')).toBe(true);
        expect(doubleSlash.test('a/b/x.never')).toBe(false); // no empty segment — must reject, not hang
        expect(doubleSlash.test('a/'.repeat(35) + 'b')).toBe(false);
      });

      it('non-adjacent single "*" tokens separated by literal text (CodeRabbit finding)', () => {
        const re = compileGlob('*a'.repeat(12) + 'Z');
        expect(re.test('a'.repeat(40) + 'Y')).toBe(false); // no trailing "Z" — must reject, not hang
        expect(re.test('a'.repeat(40) + 'Z')).toBe(true);
      });
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
