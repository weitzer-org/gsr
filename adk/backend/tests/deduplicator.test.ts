import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { DeduplicatorAgent } from '../src/deduplicator';

describe('DeduplicatorAgent', () => {
    let deduplicator: DeduplicatorAgent;

    beforeEach(async () => {
        jest.resetModules();
        process.env.USE_VERTEX_AI = 'false';
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

    it('should make an LLM call and parse the result', async () => {
        const mockGenerate = jest.fn<any>().mockResolvedValue({
            text: JSON.stringify([{ file: 'merged.ts', line: 10, severity: 'HIGH', summary: 'dup', description: 'merged' }]),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        });
        (deduplicator as any).ai = { models: { generateContent: mockGenerate } };

        const inputFindings: any = [
            { file: 'merged.ts', line: 10, severity: 'LOW', summary: 'minor', description: 'desc1' },
            { file: 'merged.ts', line: 10, severity: 'HIGH', summary: 'major', description: 'desc2' }
        ];

        const results = await deduplicator.deduplicate(inputFindings);
        
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(results).toHaveLength(1);
        expect(results[0].summary).toBe('dup');
    });

    it('should fallback to raw findings on LLM error', async () => {
        const mockGenerate = jest.fn().mockImplementation(() => Promise.reject(new Error('LLM Failure')));
        (deduplicator as any).ai = { models: { generateContent: mockGenerate } };

        const inputFindings: any = [
            { file: 'merged.ts', line: 10, severity: 'LOW', summary: 'minor', description: 'desc1' }
        ];

        const results = await deduplicator.deduplicate(inputFindings);
        
        // returns original unmodified
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(results).toEqual(inputFindings);
    });
});
