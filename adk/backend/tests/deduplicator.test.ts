import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { DeduplicatorAgent, applyMergeGroups } from '../src/deduplicator';

// See tests/agent.test.ts's identical mock for why: trackGeminiCall's real
// implementation writes to S3-compatible storage (src/usage.ts) — pass
// through to fn() here instead of making a real network call per test.
jest.mock('../src/usage', () => ({
    trackGeminiCall: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

describe('DeduplicatorAgent', () => {
    let deduplicator: DeduplicatorAgent;

    beforeEach(async () => {
        jest.resetModules();
        process.env.USE_DEDUPLICATOR = 'true';
        process.env.GEMINI_API_KEY = 'test-key';

        const mod = await import('../src/deduplicator.js');
        deduplicator = new mod.DeduplicatorAgent();
    });

    it('should initialize successfully', () => {
        expect(deduplicator).toBeDefined();
    });

    it('should return empty array if no findings provided', async () => {
        const results = await deduplicator.deduplicate([]);
        expect(results).toEqual([]);
    });

    it('should bypass deduplicator if USE_DEDUPLICATOR is false', async () => {
        process.env.USE_DEDUPLICATOR = 'false';
        const mockFindings: any = [{ file: 'test.ts', line: 1 }];
        
        // This won't hit the LLM
        const results = await deduplicator.deduplicate(mockFindings);
        expect(results).toEqual(mockFindings);
    });

    const finding = (file: string, line: number, severity: string, agent: string, extra: object = {}): any =>
        ({ file, line, severity, agent, summary: `${agent} summary`, description: `${agent} description`, ...extra });

    const mockGroups = (groups: unknown) => {
        const mockGenerate = jest.fn<any>().mockResolvedValue({
            text: JSON.stringify(groups),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        });
        (deduplicator as any).ai = { models: { generateContent: mockGenerate } };
        return mockGenerate;
    };

    it('merges a group in code: highest severity wins, agents are joined, a missing suggestion is borrowed', async () => {
        const mockGenerate = mockGroups([{ indices: [0, 1] }]);
        const input = [
            finding('a.ts', 10, 'LOW', 'Performance', { suggestion: 'fix it' }),
            finding('a.ts', 12, 'HIGH', 'Security'),
        ];

        const results = await deduplicator.deduplicate(input);

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(results).toEqual([
            { ...input[1], agent: 'Performance, Security', suggestion: 'fix it' },
        ]);
    });

    it('sends the model only clustered findings, without suggestions, keyed by original index', async () => {
        const mockGenerate = mockGroups([{ indices: [0] }, { indices: [2] }]);
        const input = [
            finding('a.ts', 10, 'LOW', 'Logic', { suggestion: 'long code block' }),
            finding('b.ts', 500, 'LOW', 'Testing'),
            finding('a.ts', 15, 'LOW', 'Security'),
        ];

        const results = await deduplicator.deduplicate(input);

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        const sent = JSON.parse((mockGenerate.mock.calls[0][0] as any).contents);
        expect(sent.map((s: any) => s.index)).toEqual([0, 2]);
        expect(sent[0].suggestion).toBeUndefined();
        expect(results).toEqual(input);
    });

    it('makes no LLM call when no two findings are near each other', async () => {
        const mockGenerate = mockGroups([]);
        const input = [
            finding('a.ts', 10, 'LOW', 'Logic'),
            finding('a.ts', 21, 'LOW', 'Security'), // 11 lines away: outside the window
            finding('b.ts', 10, 'LOW', 'Testing'),  // same line, different file
        ];

        const results = await deduplicator.deduplicate(input);

        expect(mockGenerate).not.toHaveBeenCalled();
        expect(results).toEqual(input);
    });

    it('never loses a finding: one giant group is split at file and distance boundaries', async () => {
        // The "collapse" failure mode: the model claims everything is one issue.
        mockGroups([{ indices: [0, 1, 2, 3] }]);
        const input = [
            finding('a.ts', 10, 'LOW', 'Logic'),
            finding('a.ts', 12, 'LOW', 'Security'),
            finding('a.ts', 300, 'LOW', 'Logic'),
            finding('a.ts', 305, 'LOW', 'Testing'),
        ];

        const results = await deduplicator.deduplicate(input);

        expect(results.map(r => [r.line, r.agent])).toEqual([[10, 'Logic, Security'], [300, 'Logic, Testing']]);
    });

    it('keeps findings the model omitted, and ignores unknown, repeated and malformed indices', async () => {
        mockGroups([{ indices: [0, 1, 99, -1, 'x'] }, { indices: [1, 2] }, 'junk', { nope: true }]);
        const input = [
            finding('a.ts', 10, 'LOW', 'Logic'),
            finding('a.ts', 11, 'LOW', 'Security'),
            finding('a.ts', 12, 'LOW', 'Testing'),
            finding('a.ts', 13, 'LOW', 'Performance'),
        ];

        const results = await deduplicator.deduplicate(input);

        // 0+1 merge; 1 is already used so [1,2] leaves 2 alone; 3 was never mentioned.
        expect(results.map(r => r.agent)).toEqual(['Logic, Security', 'Testing', 'Performance']);
    });

    it('returns the findings unmerged when the response is not a list of groups', async () => {
        mockGroups({ indices: [0, 1] });
        const input = [finding('a.ts', 10, 'LOW', 'Logic'), finding('a.ts', 11, 'LOW', 'Security')];

        expect(await deduplicator.deduplicate(input)).toEqual(input);
    });

    it('should fallback to raw findings on LLM error', async () => {
        const mockGenerate = jest.fn().mockImplementation(() => Promise.reject(new Error('LLM Failure')));
        (deduplicator as any).ai = { models: { generateContent: mockGenerate } };

        const inputFindings: any = [
            { file: 'merged.ts', line: 10, severity: 'LOW', summary: 'minor', description: 'desc1' },
            { file: 'merged.ts', line: 11, severity: 'LOW', summary: 'minor2', description: 'desc2' }
        ];

        const results = await deduplicator.deduplicate(inputFindings);
        
        // returns original unmodified
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(results).toEqual(inputFindings);
    });
});

describe('applyMergeGroups', () => {
    const f = (line: number, agent: string): any => ({ file: 'a.ts', line, severity: 'LOW', agent, summary: agent, description: agent });

    it('collapses each group at its first member and leaves the rest in order, with no model call', () => {
        const input = [f(1, 'A'), f(2, 'B'), f(3, 'C'), f(4, 'D'), f(5, 'E')];

        const out = applyMergeGroups(input, [[1, 3], [2, 4]]);

        expect(out.map(x => x.agent)).toEqual(['A', 'B, D', 'C, E']);
        expect(out[0]).toBe(input[0]);
    });

    it('returns every finding unchanged when there are no groups', () => {
        const input = [f(1, 'A'), f(2, 'B')];
        expect(applyMergeGroups(input, [])).toEqual(input);
    });
});
