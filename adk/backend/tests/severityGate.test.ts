import { shouldFailOnSeverity } from '../src/severityGate';

describe('shouldFailOnSeverity', () => {
    const findings: any = [
        { file: 'a.ts', line: 1, severity: 'LOW', summary: 's', description: 'd' },
        { file: 'b.ts', line: 2, severity: 'HIGH', summary: 's', description: 'd' }
    ];

    it('never fails when threshold is "none"', () => {
        expect(shouldFailOnSeverity(findings, 'none')).toBe(false);
    });

    it('fails when a finding meets the threshold', () => {
        expect(shouldFailOnSeverity(findings, 'high')).toBe(true);
        expect(shouldFailOnSeverity(findings, 'medium')).toBe(true);
    });

    it('does not fail when no finding meets the threshold', () => {
        expect(shouldFailOnSeverity(findings, 'critical')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(shouldFailOnSeverity(findings, 'HIGH')).toBe(true);
    });

    it('returns false for an empty findings list', () => {
        expect(shouldFailOnSeverity([], 'low')).toBe(false);
    });

    it('throws on an invalid threshold', () => {
        expect(() => shouldFailOnSeverity(findings, 'bogus')).toThrow('Invalid fail-on-severity value');
    });
});
