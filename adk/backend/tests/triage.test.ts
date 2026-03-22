import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TriageRouter } from '../src/triage';

describe('TriageRouter', () => {
    let router: TriageRouter;

    beforeEach(() => {
        router = new TriageRouter();
    });

    it('should handle API errors and throw', async () => {
        // Mock the internal AI client
        const mockGenerateContent = jest.fn<any>().mockRejectedValue(new Error('API Error'));
        (router as any).ai = {
            models: { generateContent: mockGenerateContent }
        };

        await expect(router.predictRouting([{file: 'x', content: 'y'}], [])).rejects.toThrow('API Error');
    });

    it('should parse valid JSON routing maps', async () => {
        const mockGenerateContent = jest.fn<any>().mockResolvedValue({
            text: '{"index.ts": ["Logic"]}',
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
        });
        (router as any).ai = {
            models: { generateContent: mockGenerateContent }
        };

        const result = await router.predictRouting([{file: 'index.ts', content: 'test'}], [{name: 'Logic', promptContent: 'test'}]);
        
        expect(result.routingMap).toEqual({"index.ts": ["Logic"]});
        expect(result.usage.promptTokens).toBe(10);
        expect(result.usage.candidatesTokens).toBe(5);
    });

    it('should return empty map if response text is missing or unparseable gracefully handled by JSON.parse', async () => {
        const mockGenerateContent = jest.fn<any>().mockResolvedValue({
            text: ''
        });
        (router as any).ai = {
            models: { generateContent: mockGenerateContent }
        };

        const result = await router.predictRouting([{file: 'index.ts', content: 'test'}], []);
        expect(result.routingMap).toEqual({});
        expect(result.usage.promptTokens).toBe(0);
    });
});
