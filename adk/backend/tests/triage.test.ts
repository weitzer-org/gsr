import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TriageRouter } from '../src/triage';
import * as originalFs from 'fs';

const readFileSyncMock = jest.fn<any>();

jest.unstable_mockModule('fs', () => ({
    ...originalFs,
    readFileSync: readFileSyncMock
}));

describe('TriageRouter', () => {
    let router: TriageRouter;

    beforeEach(async () => {
        jest.resetModules();
        readFileSyncMock.mockReset();
        process.env.GEMINI_API_KEY = 'test-key';
        
        // Dynamic import to wire up the mocked fs
        const mod = await import('../src/triage.js');
        const TriageRouterClass = mod.TriageRouter;
        router = new TriageRouterClass();
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

    it('should load TOML prompt successfully if file exists', async () => {
        const mockGenerateContent = jest.fn<any>().mockResolvedValue({
            text: JSON.stringify({ 'index.ts': ['Logic'] }),
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        });
        (router as any).ai = { models: { generateContent: mockGenerateContent } };
        
        readFileSyncMock.mockReturnValue('prompt = """Custom TOML Routing Logic"""');
        await router.predictRouting([{file: 'index.ts', content: 'test'}], []);
        
        expect(readFileSyncMock).toHaveBeenCalled();
        expect(mockGenerateContent).toHaveBeenCalled();
        const callArgs: any = mockGenerateContent.mock.calls[0][0];
        expect(callArgs.config.systemInstruction).toContain('Custom TOML Routing Logic');
    });

    it('should fallback to hardcoded string if TOML file is missing', async () => {
        const mockGenerateContent = jest.fn<any>().mockResolvedValue({
            text: JSON.stringify({ 'index.ts': ['Logic'] }),
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }
        });
        (router as any).ai = { models: { generateContent: mockGenerateContent } };

        readFileSyncMock.mockImplementation(() => { throw new Error('File not found'); });
        await router.predictRouting([{file: 'index.ts', content: 'test'}], []);

        expect(readFileSyncMock).toHaveBeenCalled();
        const callArgs: any = mockGenerateContent.mock.calls[0][0];
        expect(callArgs.config.systemInstruction).toContain('You are a highly efficient Triage Router');
    });
});
