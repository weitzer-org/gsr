import { describe, it, expect } from '@jest/globals';
import { isCodeFile, qualifies, interleave, MIN_CODE_FILES, MAX_PATCH_BYTES } from '../select-large-prs';

const PATCH = '@@ -1 +1 @@\n+x';
const f = (filename: string, patch: string | null = PATCH) => ({ filename, patch: patch === null ? undefined : patch });
const many = (n: number, ext = 'ts') => Array.from({ length: n }, (_, i) => f(`src/f${i}.${ext}`));

describe('large-PR selection rule', () => {
  it('counts only code files that have a patch and are not ignored or documentation', () => {
    expect(isCodeFile(f('src/a.ts'))).toBe(true);
    expect(isCodeFile(f('main.go'))).toBe(true);
    expect(isCodeFile(f('README.md'))).toBe(false);
    expect(isCodeFile(f('docs/guide.ts'))).toBe(false);
    expect(isCodeFile(f('package-lock.json'))).toBe(false);
    expect(isCodeFile(f('data.json'))).toBe(false);
    expect(isCodeFile(f('dist/app.js'))).toBe(false);
    expect(isCodeFile(f('x.min.js'))).toBe(false);
    expect(isCodeFile(f('src/binary.ts', null))).toBe(false); // no patch => the review never sees it
  });

  it('needs >= 10 code files: 9 does not qualify, 10 does', () => {
    expect(MIN_CODE_FILES).toBe(10);
    expect(qualifies(many(9)).ok).toBe(false);
    expect(qualifies(many(10)).ok).toBe(true);
  });

  it('a docs-only PR can never qualify, however many files', () => {
    const q = qualifies(many(40, 'md'));
    expect(q.ok).toBe(false);
    expect(q.codeFiles).toBe(0);
    expect(q.totalFiles).toBe(40);
  });

  it('mixed PRs count only the code files toward the threshold', () => {
    expect(qualifies([...many(6), ...many(20, 'md')]).ok).toBe(false);
    expect(qualifies([...many(10), ...many(20, 'md')]).ok).toBe(true);
  });

  it('an enormous diff is excluded to keep one PR from dominating the cost', () => {
    const big = [...many(10), f('src/huge.ts', 'x'.repeat(MAX_PATCH_BYTES + 1))];
    expect(qualifies(big).ok).toBe(false);
  });

  it('interleaves repos newest-first, alternately', () => {
    expect(interleave([['a1', 'a2', 'a3'], ['b1', 'b2']])).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });
});
