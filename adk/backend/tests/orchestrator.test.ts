import { jest } from '@jest/globals';
import { Orchestrator } from '../src/orchestrator';
import { GeminiAgent } from '../src/agent';

describe('Orchestrator', () => {
    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-key';
        jest.restoreAllMocks();
    });

    it('should initialize with logic agent when constructed', () => {
        const orchestrator = new Orchestrator();
        expect(orchestrator).toBeDefined();
    });

    it('should return empty array if no chunks provided', async () => {
        const orchestrator = new Orchestrator();
        const results = await orchestrator.runReview([]);
        expect(results.findings).toEqual([]);
    });


    it('should aggregate findings and filter low severity', async () => {
        // Setup mock return for GeminiAgent
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze')
            .mockResolvedValue({
                findings: [
                    { file: 'test.ts', line: 1, severity: 'HIGH', summary: 'High issue', description: 'Desc', agent: 'Logic' },
                    // @ts-ignore - TRIVIAL is intentionally invalid to test filtering
                    { file: 'test.ts', line: 2, severity: 'TRIVIAL', summary: 'Low issue', description: 'Desc', agent: 'Logic' }
                ]
            });


        const orchestrator = new Orchestrator(1);
        // @ts-ignore - force single agent for test isolation
        orchestrator.subagents = [new GeminiAgent('Logic', 'logic.md')];
        
        let progressCalls: any[] = [];
        orchestrator.onProgress = (name, file, status) => {
            progressCalls.push({name, file, status});
        };

        const chunks = [{ file: 'test.ts', content: '+ new code' }];
        const results = await orchestrator.runReview(chunks);

        expect(mockAnalyze).toHaveBeenCalledWith(chunks[0]);
        // Only high severity should remain
        expect(results.findings).toHaveLength(1);
        expect(results.findings[0].severity).toBe('HIGH');

        
        expect(progressCalls).toHaveLength(2);
        expect(progressCalls[0].status).toBe('start');
        expect(progressCalls[1].status).toBe('complete');
    });

    it('should emit complete progress even if analyze throws', async () => {
        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockRejectedValue(new Error('Agent Failed'));

        const orchestrator = new Orchestrator(1);
        // @ts-ignore - force single agent for test isolation
        orchestrator.subagents = [new GeminiAgent('Logic', 'logic.md')];
        
        let progressCalls: any[] = [];
        orchestrator.onProgress = (name, file, status) => {
            progressCalls.push({status});
        };

        await expect(orchestrator.runReview([{ file: 't.ts', content: 'x' }]))
            .rejects.toThrow('Agent Failed');

        expect(progressCalls).toEqual([{ status: 'start' }, { status: 'complete' }]);
    });
});
