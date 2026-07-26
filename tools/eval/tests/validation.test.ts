import { validateFindingsAgainstDiff } from '../validation';
import { ReviewFinding } from '../api-client';

function finding(fileName: string, lineNumber: number): ReviewFinding {
    return { fileName, lineNumber } as ReviewFinding;
}

describe('validateFindingsAgainstDiff fallback path matching', () => {
    it('matches a finding against a diff chunk via directory-suffix fallback', () => {
        const diffChunks = [{ file: 'src/components/Button.tsx', content: '@@ -1,1 +1,1 @@\n+x' }];
        const findings = [finding('components/Button.tsx', 1)];

        const { validFindings, hallucinatedFindings } = validateFindingsAgainstDiff(findings, diffChunks);

        expect(validFindings).toHaveLength(1);
        expect(hallucinatedFindings).toHaveLength(0);
    });

    it('does not falsely match an unrelated file via double normalization of a real "a/" directory', () => {
        // The diff chunk lives in a real top-level directory named 'a' (git prefix
        // 'b/' + repo path 'a/utils.ts'). A single normalizeFilePath call strips only
        // the git prefix, leaving 'a/utils.ts'. If the fallback loop re-normalizes
        // this already-clean string (the bug), it strips the literal 'a/' directory
        // too, collapsing it to bare 'utils.ts' — which then spuriously suffix-matches
        // any unrelated file also named utils.ts, like 'z/utils.ts' below.
        const diffChunks = [{ file: 'b/a/utils.ts', content: '@@ -1,1 +1,1 @@\n+x' }];
        const unrelatedFinding = [finding('z/utils.ts', 1)];

        const { validFindings, hallucinatedFindings } = validateFindingsAgainstDiff(unrelatedFinding, diffChunks);

        expect(validFindings).toHaveLength(0);
        expect(hallucinatedFindings).toHaveLength(1);
    });

    it('still matches the correct file when its path also carries a real "a/" directory', () => {
        const diffChunks = [{ file: 'b/a/utils.ts', content: '@@ -1,1 +1,1 @@\n+x' }];
        const correctFinding = [finding('a/a/utils.ts', 1)];

        const { validFindings, hallucinatedFindings } = validateFindingsAgainstDiff(correctFinding, diffChunks);

        expect(validFindings).toHaveLength(1);
        expect(hallucinatedFindings).toHaveLength(0);
    });
});
