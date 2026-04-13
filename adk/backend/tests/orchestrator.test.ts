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
