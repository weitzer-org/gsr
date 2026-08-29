import { jest } from '@jest/globals';
import { GeminiAgent } from '../src/agent';

// trackGeminiCall's real implementation writes to S3-compatible storage
// (see src/usage.ts) — transparently pass through to fn() here so these
// tests exercise the real generateContent-mocking/response-handling logic
// without making a real (and, in this sandboxed test environment, failing
// and retrying) network call on every analyze() call.
jest.mock('../src/usage', () => ({
    trackGeminiCall: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

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

    it('should retry with ONLY the missed file, not the full diff, when windowing is off', async () => {
        // Regression test for a bug caught in review before this shipped: an
        // earlier version of the windowing feature always passed the full
        // chunk list plus a focus set to buildDiscoveryPrompt, which meant a
        // plain (non-windowed) retry silently re-sent the ENTIRE diff instead
        // of just the missed file — duplicating that agent's discovery
        // output on every retry, in the default (windowing-off) control path.
        const agent = new GeminiAgent('Logic', 'logic.md');

        const mockGenerateContent = jest.fn<any>()
          .mockResolvedValueOnce({
            text: JSON.stringify({ filesAnalyzed: ['found.ts'], issues: [] }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          })
          .mockResolvedValueOnce({
            text: JSON.stringify({ filesAnalyzed: ['missed.ts'], issues: [] }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          });

        agent['ai'] = { models: { generateContent: mockGenerateContent } } as any;

        await agent.analyze([
          { file: 'found.ts', content: '+ foo' },
          { file: 'missed.ts', content: '+ bar' }
        ]);

        const retryCallArgs = mockGenerateContent.mock.calls[1][0] as any;
        expect(retryCallArgs.contents).toContain('missed.ts');
        expect(retryCallArgs.contents).not.toContain('found.ts');
        expect(retryCallArgs.contents).not.toContain('FOCUS_FILES');
    });

    it('should split discovery into focus windows and filter out-of-window issues', async () => {
        process.env.DISCOVERY_FOCUS_WINDOW = '2';
        const agent = new GeminiAgent('Logic', 'logic.md');

        const mockGenerateContent = jest.fn<any>()
          // Window 1 (a.ts, b.ts): correctly scoped, plus one issue the
          // model reports outside its window — must be filtered, not kept.
          .mockResolvedValueOnce({
            text: JSON.stringify({
              filesAnalyzed: ['a.ts', 'b.ts'],
              issues: [
                { file: 'a.ts', line: 1, severity: 'LOW', summary: 'in window' },
                { file: 'c.ts', line: 1, severity: 'LOW', summary: 'out of window, must be dropped' }
              ]
            }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          })
          // Window 2 (c.ts): correctly scoped
          .mockResolvedValueOnce({
            text: JSON.stringify({
              filesAnalyzed: ['c.ts'],
              issues: [{ file: 'c.ts', line: 1, severity: 'LOW', summary: 'in window' }]
            }),
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          })
          // Pass 2 (remediation), one call over the merged, filtered list
          .mockResolvedValueOnce({
            text: JSON.stringify([
              { file: 'a.ts', line: 1, severity: 'LOW', summary: 'in window', description: 'd', suggestion: 's' },
              { file: 'c.ts', line: 1, severity: 'LOW', summary: 'in window', description: 'd', suggestion: 's' }
            ]),
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 }
          });

        agent['ai'] = { models: { generateContent: mockGenerateContent } } as any;

        const result = await agent.analyze([
          { file: 'a.ts', content: '+ a' },
          { file: 'b.ts', content: '+ b' },
          { file: 'c.ts', content: '+ c' }
        ]);

        // 3 files / window 2 -> windows of [a,b] and [c] -> 2 discovery calls + 1 remediation call
        expect(mockGenerateContent).toHaveBeenCalledTimes(3);

        const window1Args = mockGenerateContent.mock.calls[0][0] as any;
        expect(window1Args.contents).toContain('a.ts');
        expect(window1Args.contents).toContain('b.ts');
        expect(window1Args.contents).toContain('c.ts'); // full diff still present as context
        expect(window1Args.contents).toContain('FOCUS_FILES');

        // The out-of-window "c.ts" issue from window 1's response must not
        // have survived into the findings the remediation call was given.
        const remediationArgs = mockGenerateContent.mock.calls[2][0] as any;
        const flaggedIssuesMatch = remediationArgs.contents.match(/<FLAGGED_ISSUES>([\s\S]*?)<\/FLAGGED_ISSUES>/);
        const flaggedIssues = JSON.parse(flaggedIssuesMatch[1]);
        expect(flaggedIssues).toHaveLength(2); // a.ts (window 1) + c.ts (window 2), not the duplicate c.ts from window 1

        expect(result.findings).toHaveLength(2);
    });

    it('should perform legacy analysis when USE_TRIAGE_AGENT is false', async () => {
        process.env.USE_TRIAGE_AGENT = 'false';
        const agent = new GeminiAgent('Logic', 'logic.md');
        
        const mockGenerateContent = jest.fn<any>().mockResolvedValueOnce({
            text: JSON.stringify([
              { file: 'app.ts', line: 10, severity: 'MEDIUM', summary: 'Sum', description: 'Desc', suggestion: 'Fixed' }
            ]),
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
        });

        agent['ai'] = { models: { generateContent: mockGenerateContent } } as any;

        const result = await agent.analyze([{ file: 'app.ts', content: '+ app' }]);
        
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]).toEqual(expect.objectContaining({ 
          file: 'app.ts', severity: 'MEDIUM', description: 'Desc', agent: 'Logic' 
        }));
        expect(result.usage?.promptTokenCount).toBe(100);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
});
