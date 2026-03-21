import { jest } from '@jest/globals';
import { GeminiAgent } from '../src/agent';

describe('GeminiAgent', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.GEMINI_API_KEY = 'test-key';
        process.env.GEMINI_MODEL = 'test-model';
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should construct correctly', () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        expect(agent.name).toBe('Logic');
    });

    it('should return empty array if generateContent throws an error', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        // @ts-ignore mock the ai property behavior since it's instantiated inside
        agent.ai = {
            models: {
                generateContent: jest.fn().mockImplementation(() => Promise.reject(new Error('API Error')))
            }
        } as any;

        const result = await agent.analyze([{ file: 'test.ts', content: '+ test' }]);
        expect(result.findings).toEqual([]);
    });


    it('should return parsed findings if response has valid JSON text', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        const mockResponseJSON = JSON.stringify([
            { file: 'app.ts', line: 10, severity: 'MEDIUM', summary: 'Sum', description: 'Desc' }
        ]);

        // @ts-ignore mock
        agent.ai = {
            models: {
                generateContent: jest.fn().mockImplementation(() => Promise.resolve({
                    text: mockResponseJSON
                }))
            }
        } as any;

        const result = await agent.analyze([{ file: 'app.ts', content: 'test' }]);
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toMatchObject({
            file: 'app.ts',
            agent: 'Logic',
            severity: 'MEDIUM'
        });
    });


    it('should return empty if response text is empty', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        // @ts-ignore
        agent.ai = { models: { generateContent: jest.fn().mockImplementation(() => Promise.resolve({ text: null })) } } as any;

        const result = await agent.analyze([{ file: 'a.ts', content: 'a' }]);
        expect(result.findings).toEqual([]);
    });

    it('should extract usage metadata when present', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        const mockResponseJSON = JSON.stringify([]);
        
        // @ts-ignore
        agent.ai = {
            models: {
                generateContent: jest.fn().mockImplementation(() => Promise.resolve({
                    text: mockResponseJSON,
                    usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 20,
                        totalTokenCount: 30
                    }
                }))
            }
        } as any;

        const result = await agent.analyze([{ file: 'app.ts', content: 'test' }]);
        expect(result.usage).toBeDefined();
        expect(result.usage?.promptTokenCount).toBe(10);
        expect(result.usage?.candidatesTokenCount).toBe(20);
    });

    it('should use gemini-2.5-pro as fallback model if GEMINI_MODEL is not set', async () => {
        delete process.env.GEMINI_MODEL;
        const agent = new GeminiAgent('Logic', 'logic.md');
        const generateContentSpy = jest.fn().mockImplementation(() => Promise.resolve({ text: '[]' }));
        // @ts-ignore
        agent.ai = { models: { generateContent: generateContentSpy } } as any;

        await agent.analyze([{ file: 'test.ts', content: 'test' }]);
        
        expect(generateContentSpy).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-2.5-pro'
        }));
    });
});
