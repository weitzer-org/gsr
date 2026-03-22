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
        agent['ai'] = {
            models: {
                generateContent: jest.fn<any>().mockImplementation(() => Promise.reject(new Error('API Error')))
            }
        } as any;

        const result = await agent.analyze([{ file: 'test.ts', content: '+ test' }]);
        expect(result.findings).toEqual([]);
    });

    it('should perform two-pass analysis with filesAnalyzed coverage validation', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        
        const mockGenerateContent = jest.fn<any>()
          // Pass 1: Discovery Model Response
          .mockResolvedValueOnce({
            text: JSON.stringify({
              filesAnalyzed: ['app.ts'],
              issues: [{ file: 'app.ts', line: 10, severity: 'MEDIUM', summary: 'Sum' }]
            }),
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
          })
          // Pass 2: Remediation Model Response
          .mockResolvedValueOnce({
            text: JSON.stringify([
              { file: 'app.ts', line: 10, severity: 'MEDIUM', summary: 'Sum', description: 'Desc', suggestion: 'Fixed' }
            ]),
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 150 }
          });

        agent['ai'] = { models: { generateContent: mockGenerateContent } } as any;

        const result = await agent.analyze([{ file: 'app.ts', content: '+ app' }]);
        
        // Assert Findings
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toEqual(expect.objectContaining({ 
          file: 'app.ts', severity: 'MEDIUM', description: 'Desc', suggestion: 'Fixed', agent: 'Logic' 
        }));

        // Assert Tokens accumulated
        expect(result.usage?.promptTokenCount).toBe(300);
        expect(result.usage?.candidatesTokenCount).toBe(200);

        // Assert 2 calls were made natively passing SystemInstructions
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('should retry if Pass 1 misses files from filesAnalyzed', async () => {
        const agent = new GeminiAgent('Logic', 'logic.md');
        
        const mockGenerateContent = jest.fn<any>()
          // Pass 1 (Attempt 1): Drop the file 'missed.ts'
          .mockResolvedValueOnce({
            text: JSON.stringify({ filesAnalyzed: ['found.ts'], issues: [] }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          })
          // Pass 1 (Attempt 2): Eventually scan 'missed.ts'
          .mockResolvedValueOnce({
            text: JSON.stringify({ filesAnalyzed: ['missed.ts'], issues: [] }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          });

        agent['ai'] = { models: { generateContent: mockGenerateContent } } as any;

        const result = await agent.analyze([
          { file: 'found.ts', content: '+ foo' },
          { file: 'missed.ts', content: '+ bar' }
        ]);
        
        // Total Findings is 0, so Pass 2 never fires
        expect(result.findings).toHaveLength(0);
        // But Generate content was called exactly twice iteratively for the retry!
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
});
