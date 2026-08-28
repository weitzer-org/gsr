import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Orchestrator } from '../src/orchestrator';
import { GeminiAgent } from '../src/agent';
import { DeduplicatorAgent } from '../src/deduplicator';
import { computeFindingId } from '../src/findingMarker';

describe('Orchestrator', () => {
    beforeEach(async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        jest.restoreAllMocks();
        
        // Mock Deduplicator by default to isolate Orchestrator logic
        jest.spyOn(DeduplicatorAgent.prototype, 'deduplicate').mockImplementation(async (findings: any) => findings);
    });

    it('should initialize successfully from fs', () => {
        const orchestrator = new Orchestrator();
        expect(orchestrator).toBeDefined();
        expect((orchestrator as any).subagents.length).toBeGreaterThan(0);
    });

    it('should return empty array if no chunks provided', async () => {
        const orchestrator = new Orchestrator();
        const results = await orchestrator.runReview([]);
        expect(results.findings).toEqual([]);
    });

    it('should load only the selected agents when selectedAgents is provided', () => {
        const orchestrator = new Orchestrator(5, 'system_prompts', true, ['logic', 'security']);
        const names = (orchestrator as any).subagents.map((a: GeminiAgent) => a.name.toLowerCase()).sort();
        expect(names).toEqual(['logic', 'security']);
    });

    it('should be case-insensitive when matching selectedAgents', () => {
        const orchestrator = new Orchestrator(5, 'system_prompts', true, ['LOGIC']);
        const names = (orchestrator as any).subagents.map((a: GeminiAgent) => a.name.toLowerCase());
        expect(names).toEqual(['logic']);
    });

    it('should load all agents when selectedAgents is undefined', () => {
        const all = new Orchestrator();
        const filtered = new Orchestrator(5, 'system_prompts', true, undefined);
        expect((filtered as any).subagents.length).toBe((all as any).subagents.length);
    });

    it('listAgentIds should return the lowercase filename stems of available agents', () => {
        const ids = Orchestrator.listAgentIds('system_prompts');
        expect(ids).toEqual(expect.arrayContaining(['logic', 'security', 'architecture']));
        expect(ids.every(id => id === id.toLowerCase())).toBe(true);
    });

    it('listAgents should return ids paired with display names matching the loaded agent names', () => {
        const agents = Orchestrator.listAgents('system_prompts');
        const logicEntry = agents.find(a => a.id === 'logic');
        expect(logicEntry).toEqual({ id: 'logic', displayName: 'Logic' });

        const orchestrator = new Orchestrator();
        const loadedNames = (orchestrator as any).subagents.map((a: GeminiAgent) => a.name).sort();
        const listedDisplayNames = agents.map(a => a.displayName).sort();
        expect(listedDisplayNames).toEqual(loadedNames);
    });

    it('should compose selection with ablation: only non-ablated selected agents run', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });
        process.env.ABLATE_LOGIC = 'true';

        try {
            const orchestrator = new Orchestrator(5, 'system_prompts', true, ['logic', 'security']);
            await orchestrator.runReview([{ file: 'index.ts', content: 'x' }]);

            const calledAgentNames = mockAnalyze.mock.contexts.map((ctx: any) => ctx.name.toLowerCase());
            expect(calledAgentNames).toEqual(['security']);
        } finally {
            delete process.env.ABLATE_LOGIC;
            mockAnalyze.mockRestore();
        }
    });

    it('should filter chunks based on shouldRun rules for specific agents', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [
            new GeminiAgent('Security', 'security.md'),
            new GeminiAgent('Logic', 'logic.md')
        ];
        
        await orchestrator.runReview([
            { file: 'package.json', content: 'x' },
            { file: 'index.ts', content: 'x' }
        ]);

        expect(mockAnalyze).toHaveBeenCalledTimes(2); 
    });

    it('should use DeduplicatorAgent to merge findings', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ 
            findings: [{ file: 'index.ts', line: 1, severity: 'HIGH', summary: 'dup', description: 'desc', agent: 'Agent' }] as any
        });

        const mockDeduplicate = jest.spyOn(DeduplicatorAgent.prototype, 'deduplicate').mockResolvedValue([
            { file: 'index.ts', line: 1, severity: 'HIGH', summary: 'merged summary', description: 'merged desc', agent: 'merged' } as any
        ]);

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [
            new GeminiAgent('Performance', 'test'),
            new GeminiAgent('Security', 'test')
        ];

        const chunks = [
            { file: 'index.ts', content: 'x' }
        ];

        const results = await orchestrator.runReview(chunks);

        expect(mockAnalyze).toHaveBeenCalledTimes(2); 
        expect(mockDeduplicate).toHaveBeenCalledTimes(1);
        expect(results.findings).toHaveLength(1);
        expect(results.findings[0].summary).toBe('merged summary');

        mockAnalyze.mockRestore();
        mockDeduplicate.mockRestore();
    });

    it('assigns findingId AFTER deduplication, from the merged agent — not the pre-dedup one ' +
       '(review-quality-design.md §2.1 addendum: dedup-time agent merges like "Performance, Security" ' +
       'must be reflected in the hash)', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [{ file: 'index.ts', line: 1, severity: 'HIGH', summary: 'dup', description: 'desc', agent: 'Performance' }] as any
        });

        const mockDeduplicate = jest.spyOn(DeduplicatorAgent.prototype, 'deduplicate').mockResolvedValue([
            { file: 'index.ts', line: 1, severity: 'HIGH', summary: 'merged summary', description: 'merged desc', agent: 'Performance, Security' } as any
        ]);

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [
            new GeminiAgent('Performance', 'test'),
            new GeminiAgent('Security', 'test')
        ];

        const results = await orchestrator.runReview([{ file: 'index.ts', content: 'x' }]);

        expect(results.findings).toHaveLength(1);
        expect(results.findings[0].id).toBe(computeFindingId({ file: 'index.ts', line: 1, agent: 'Performance, Security' }));
        expect(results.findings[0].id).not.toBe(computeFindingId({ file: 'index.ts', line: 1, agent: 'Performance' }));

        mockAnalyze.mockRestore();
        mockDeduplicate.mockRestore();
    });

    it('leaves an already-assigned findingId untouched rather than recomputing it', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [{ file: 'index.ts', line: 1, severity: 'HIGH', summary: 's', description: 'd', agent: 'Logic', id: 'preset-id' }] as any
        });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'test')];

        const results = await orchestrator.runReview([{ file: 'index.ts', content: 'x' }]);

        expect(results.findings[0].id).toBe('preset-id');

        mockAnalyze.mockRestore();
    });

    it('should filter low severity', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze')
            .mockResolvedValue({
                findings: [
                    { file: 'test.ts', line: 1, severity: 'HIGH', summary: 'High issue', description: 'Desc', agent: 'Logic' },
                    { file: 'test.ts', line: 2, severity: 'TRIVIAL', summary: 'Low issue', description: 'Desc', agent: 'Logic' } as any
                ]
            });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];
        
        const chunks = [{ file: 'test.ts', content: '+ new code' }];
        const results = await orchestrator.runReview(chunks);

        expect(mockAnalyze).toHaveBeenCalledWith(chunks);
        expect(results.findings).toHaveLength(1);
        expect(results.findings[0].severity).toBe('HIGH');
    });

    it('should not crash filtering a finding with a missing severity', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze')
            .mockResolvedValue({
                findings: [
                    { file: 'test.ts', line: 1, summary: 'No severity field', description: 'Desc', agent: 'Logic' } as any,
                    { file: 'test.ts', line: 2, severity: 'HIGH', summary: 'High issue', description: 'Desc', agent: 'Logic' }
                ]
            });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const chunks = [{ file: 'test.ts', content: '+ new code' }];
        const results = await orchestrator.runReview(chunks);

        expect(results.findings).toHaveLength(1);
        expect(results.findings[0].severity).toBe('HIGH');
    });

    it('should skip deduplicator when useDedup is false', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).useDedup = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ 
            findings: [{ file: 'i.ts', line: 1, severity: 'HIGH', summary: 'a', description: 'b', agent: 'A' }] as any
        });
        const mockDeduplicate = jest.spyOn(DeduplicatorAgent.prototype, 'deduplicate');

        await orchestrator.runReview([{ file: 'i.ts', content: 'x' }]);

        expect(mockDeduplicate).not.toHaveBeenCalled();
    });

    it('should still aggregate chunks into one call per agent when useDedup is false (basic mode config)', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });

        // useDedup=false, aggregateChunks defaults to true — matches
        // action-entrypoint.ts's basic-mode Orchestrator construction.
        const orchestrator = new Orchestrator(5, 'system_prompts', false, ['logic']);
        const chunks = [
            { file: 'main.go', content: 'x' },
            { file: 'apply.go', content: 'y' }
        ];

        await orchestrator.runReview(chunks);

        // One call for the agent covering both files, not one call per file
        // (review-quality-design.md §5.1 — regression guard for the PR #15
        // cross-file false-claim class).
        expect(mockAnalyze).toHaveBeenCalledTimes(1);
        expect(mockAnalyze).toHaveBeenCalledWith(chunks);
    });

    it('caps CRITICAL/HIGH severity to MEDIUM for findings on a default low-priority path (review-quality-design.md §4.1)', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [
                { file: 'design_prd/mockup.html', line: 5, severity: 'HIGH', summary: 'race condition', description: 'd', agent: 'Logic' },
                { file: 'internal/api/handler.go', line: 10, severity: 'HIGH', summary: 'real bug', description: 'd', agent: 'Logic' }
            ] as any
        });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'x', content: 'x' }]);

        const byFile = Object.fromEntries(results.findings.map(f => [f.file, f.severity]));
        expect(byFile['design_prd/mockup.html']).toBe('MEDIUM');
        expect(byFile['internal/api/handler.go']).toBe('HIGH');
    });

    it('should not crash dampening a finding with a missing file field (self-review finding: isLowPriorityPath.test() calls file.split, which throws on undefined)', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [
                { line: 1, severity: 'HIGH', summary: 'no file field', description: 'd', agent: 'Logic' } as any,
                { file: 'internal/api/handler.go', line: 10, severity: 'HIGH', summary: 'real bug', description: 'd', agent: 'Logic' }
            ]
        });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'x', content: 'x' }]);

        expect(results.findings).toHaveLength(2);
        expect(results.findings.find(f => f.file === 'internal/api/handler.go')?.severity).toBe('HIGH');
    });

    it('does NOT dampen a root-level shell script by default (self-review security finding: *.sh is not a built-in low-priority pattern — build.sh/deploy.sh-style CI/CD entry points must not be silently downgraded)', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [
                { file: 'deploy.sh', line: 3, severity: 'CRITICAL', summary: 'command injection', description: 'd', agent: 'Security' }
            ] as any
        });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'x', content: 'x' }]);

        expect(results.findings[0].severity).toBe('CRITICAL');
    });

    it('does not upgrade an already-low severity finding on a low-priority path', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [
                { file: 'design_prd/mockup.html', line: 5, severity: 'LOW', summary: 'nit', description: 'd', agent: 'Logic' }
            ] as any
        });

        const orchestrator = new Orchestrator(1);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'x', content: 'x' }]);

        expect(results.findings[0].severity).toBe('LOW');
    });

    it('uses a custom lowPriorityPathPatterns list when provided, instead of the defaults', async () => {
        jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({
            findings: [
                { file: 'scratch/notes.md', line: 1, severity: 'HIGH', summary: 'x', description: 'd', agent: 'Logic' },
                { file: 'design_prd/mockup.html', line: 1, severity: 'HIGH', summary: 'y', description: 'd', agent: 'Logic' }
            ] as any
        });

        // Only "scratch/**" is low-priority here — the default design_prd/**
        // pattern isn't part of this explicit list, simulating what
        // Orchestrator does with whatever parseLowPriorityPathPatterns hands
        // it (that function is what actually implements "extend, don't
        // replace" — see lowPriorityPaths.test.ts).
        const orchestrator = new Orchestrator(1, 'system_prompts', true, undefined, true, [/^scratch\//]);
        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'x', content: 'x' }]);

        const byFile = Object.fromEntries(results.findings.map(f => [f.file, f.severity]));
        expect(byFile['scratch/notes.md']).toBe('MEDIUM');
        expect(byFile['design_prd/mockup.html']).toBe('HIGH');
    });

    it('should handle errors in legacy mode when onProgress is defined', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).aggregateChunks = false;
        (orchestrator as any).useDedup = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockRejectedValue(new Error('Legacy Error'));
        
        const onProgress = jest.fn();
        orchestrator.onProgress = onProgress;

        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        await expect(orchestrator.runReview([{ file: 'i.ts', content: 'x' }])).rejects.toThrow('Legacy Error');
        
        expect(onProgress).toHaveBeenCalledWith('Logic', 'i.ts', 'failed');
    });

    it('should accumulate metrics in legacy mode', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).aggregateChunks = false;
        (orchestrator as any).useDedup = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ 
            findings: [{ file: 'i.ts', line: 1, severity: 'HIGH', summary: 'a', description: 'b', agent: 'A' }] as any,
            usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        });

        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        const results = await orchestrator.runReview([{ file: 'i.ts', content: 'x' }]);
        
        expect(results.metrics.inputTokens).toBe(10);
        expect(results.metrics.outputTokens).toBe(5);
    });

    it('should report progress in legacy mode', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).aggregateChunks = false;
        (orchestrator as any).useDedup = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });
        
        const onProgress = jest.fn();
        orchestrator.onProgress = onProgress;

        const agent = new GeminiAgent('Cicd', 'cicd.md');
        (orchestrator as any).subagents = [agent];

        await orchestrator.runReview([{ file: 'test.ts', content: 'x' }]);
        expect(onProgress).toHaveBeenCalledWith('Cicd', 'test.ts', 'skipped');

        await orchestrator.runReview([{ file: 'Dockerfile', content: 'x' }]);
        expect(onProgress).toHaveBeenCalledWith('Cicd', 'Dockerfile', 'start');
        expect(onProgress).toHaveBeenCalledWith('Cicd', 'Dockerfile', 'complete');
    });
});
