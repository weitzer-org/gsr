import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Orchestrator } from '../src/orchestrator';
import { GeminiAgent } from '../src/agent';
import { DeduplicatorAgent } from '../src/deduplicator';

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

    it('should break deduplicator when useTriage is false', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).useTriage = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ 
            findings: [{ file: 'i.ts', line: 1, severity: 'HIGH', summary: 'a', description: 'b', agent: 'A' }] as any
        });
        const mockDeduplicate = jest.spyOn(DeduplicatorAgent.prototype, 'deduplicate');

        await orchestrator.runReview([{ file: 'i.ts', content: 'x' }]);
        
        expect(mockDeduplicate).not.toHaveBeenCalled();
    });

    it('should handle errors in legacy mode when onProgress is defined', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).useTriage = false;
        
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockRejectedValue(new Error('Legacy Error'));
        
        const onProgress = jest.fn();
        orchestrator.onProgress = onProgress;

        (orchestrator as any).subagents = [new GeminiAgent('Logic', 'logic.md')];

        await expect(orchestrator.runReview([{ file: 'i.ts', content: 'x' }])).rejects.toThrow('Legacy Error');
        
        expect(onProgress).toHaveBeenCalledWith('Logic', 'i.ts', 'failed');
    });

    it('should accumulate metrics in legacy mode', async () => {
        const orchestrator = new Orchestrator();
        (orchestrator as any).useTriage = false;
        
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
        (orchestrator as any).useTriage = false;
        
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
