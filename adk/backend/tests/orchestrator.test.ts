import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { GeminiAgent } from '../src/agent';
import { TriageRouter } from '../src/triage';
import * as originalFs from 'fs';

const readdirSyncMock = jest.fn<any>();
const readFileSyncMock = jest.fn<any>();

jest.unstable_mockModule('fs', () => ({
    ...originalFs,
    readdirSync: readdirSyncMock,
    readFileSync: readFileSyncMock
}));

describe('Orchestrator', () => {
    let Orchestrator: any;

    beforeEach(async () => {
        jest.resetModules();
        readdirSyncMock.mockReset();
        readFileSyncMock.mockReset();
        readdirSyncMock.mockReturnValue(['security.md', 'logic.md']);
        readFileSyncMock.mockReturnValue('You are a test agent.');
        process.env.GEMINI_API_KEY = 'test-key';
        jest.restoreAllMocks();
        
        const mod = await import('../src/orchestrator.js');
        Orchestrator = mod.Orchestrator;
        
        // Mock Triage Router by default to isolate Orchestrator logic
        jest.spyOn(TriageRouter.prototype, 'predictRouting').mockResolvedValue({
            routingMap: {},
            usage: { promptTokens: 10, candidatesTokens: 5 }
        });
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

    it('should handle fs errors gracefully during initialization', () => {
        readdirSyncMock.mockImplementation(() => { throw new Error('Mock FS Error'); });
        const orchestrator = new Orchestrator();
        expect(orchestrator).toBeDefined();
        // Should fallback to Logic agent
        expect((orchestrator as any).subagents.length).toBe(1);
        expect((orchestrator as any).subagents[0].name).toBe('Logic');
    });

    it('should initialize agents successfully from fs', () => {
        readdirSyncMock.mockReturnValue(['security.md', 'logic.md']);
        readFileSyncMock.mockReturnValue('You are a test agent.');

        const orchestrator = new Orchestrator();
        expect((orchestrator as any).subagents.length).toBe(2);
        expect((orchestrator as any).subagents[0].name).toBe('Security');
    });

    it('should filter chunks based on shouldRun rules for specific agents', async () => {
        const orchestrator = new Orchestrator();
        orchestrator['subagents'] = [
            new GeminiAgent('Cicd', 'test'),
            new GeminiAgent('Dependencies', 'test')
        ];

        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });
        
        // Mock Triage to fail, to ensure fallback is used
        jest.spyOn(TriageRouter.prototype, 'predictRouting').mockRejectedValue(new Error('Mock Triage Failure'));

        let skippedFiles: string[] = [];
        orchestrator.onProgress = (name: any, file: any, status: any) => {
            if (status === 'skipped') skippedFiles.push(`${name}:${file}`);
        };

        const chunks = [
            { file: 'README.md', content: '' },
            { file: 'package.json', content: '' },
            { file: 'Dockerfile', content: '' }
        ];

        await orchestrator.runReview(chunks);

        expect(skippedFiles).toContain('Cicd:README.md');
        expect(skippedFiles).toContain('Cicd:package.json');
        expect(skippedFiles).toContain('Dependencies:README.md');
        expect(skippedFiles).toContain('Dependencies:Dockerfile');
        expect(skippedFiles).not.toContain('Cicd:Dockerfile');
        expect(skippedFiles).not.toContain('Dependencies:package.json');

        mockAnalyze.mockRestore();
    });
    
    it('should use routing map from TriageRouter instead of static fallback', async () => {
        const orchestrator = new Orchestrator();
        orchestrator['subagents'] = [
            new GeminiAgent('Performance', 'test'),
            new GeminiAgent('Security', 'test')
        ];

        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });
        
        // Mock Triage to return a specific routing map
        jest.spyOn(TriageRouter.prototype, 'predictRouting').mockResolvedValue({
            routingMap: {
                'index.ts': ['Performance'],
                'auth.ts': ['Security', 'Performance'],
                'ignored.txt': []
            },
            usage: { promptTokens: 10, candidatesTokens: 10 }
        });

        const chunks = [
            { file: 'index.ts', content: '' },
            { file: 'auth.ts', content: '' },
            { file: 'ignored.txt', content: '' }
        ];

        await orchestrator.runReview(chunks);

        // Performance gets index.ts and auth.ts
        // Security gets auth.ts
        // both skip ignored.txt, Security skips index.ts
        expect(mockAnalyze).toHaveBeenCalledTimes(2);

        mockAnalyze.mockRestore();
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
        orchestrator.onProgress = (name: any, file: any, status: any) => {
            progressCalls.push({name, file, status});
        };

        const chunks = [{ file: 'test.ts', content: '+ new code' }];
        const results = await orchestrator.runReview(chunks);

        expect(mockAnalyze).toHaveBeenCalledWith(chunks);
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
        orchestrator.onProgress = (name: any, file: any, status: any) => {
            progressCalls.push({status});
        };

        await expect(orchestrator.runReview([{ file: 't.ts', content: 'x' }]))
            .rejects.toThrow('Agent Failed');

        expect(progressCalls).toEqual([{ status: 'start' }, { status: 'complete' }]);
    });
    it('should bypass triage router when useTriage is false', async () => {
        readdirSyncMock.mockReturnValue(['logic.md']);
        readFileSyncMock.mockReturnValue('content');
        
        const orchestrator = new Orchestrator(5, 'system_prompts', false); // useTriage = false
        orchestrator['subagents'] = [
            new GeminiAgent('Cicd', 'test')
        ];

        const mockAnalyze = jest.spyOn(GeminiAgent.prototype, 'analyze').mockResolvedValue({ findings: [] });
        const mockTriagePredict = jest.spyOn(TriageRouter.prototype, 'predictRouting');

        const chunks = [
            { file: 'README.md', content: '' },
            { file: 'Dockerfile', content: '' } // Cicd agent should trigger here via static fallback
        ];

        await orchestrator.runReview(chunks);

        expect(mockTriagePredict).not.toHaveBeenCalled();
        expect(mockAnalyze).toHaveBeenCalledTimes(1);

        mockAnalyze.mockRestore();
        mockTriagePredict.mockRestore();
    });
});
