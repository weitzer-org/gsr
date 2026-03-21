import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Evaluator } from '../src/evaluator.js';
import { CandidateFinding } from '../src/types.js';

// Setup Mock for @google/genai before importing Evaluator
const generateContentMock = jest.fn<any>();
jest.unstable_mockModule('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: generateContentMock
    }
  }))
}));

describe('Evaluator', () => {
  let evaluator: any;

  beforeEach(async () => {
    jest.resetModules();
    generateContentMock.mockReset();

    const originalApp = await import('../src/evaluator.js');
    evaluator = new originalApp.Evaluator();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should evaluate comparison successfully and return text', async () => {
    (generateContentMock as any).mockResolvedValue({ text: 'This is a successful comparison summary.' });

    const subagentFindings: CandidateFinding[] = [{
      file: 'a.js', line: 1, agent: 'Logic', severity: 'CRITICAL', summary: 'bug',
      description: 'bug'
    }];
    const basicFindings: CandidateFinding[] = [];

    const result = await evaluator.evaluateComparison(subagentFindings, basicFindings);

    expect(result).toBe('This is a successful comparison summary.');
    expect(generateContentMock).toHaveBeenCalledWith(expect.objectContaining({
      model: expect.any(String),
      contents: expect.stringContaining('<SUBAGENT_FINDINGS>')
    }));
  });

  it('should handle undefined response text', async () => {
    (generateContentMock as any).mockResolvedValue({ text: undefined });

    const result = await evaluator.evaluateComparison([], []);

    expect(result).toBe("No evaluation generated.");
  });

  it('should catch errors and return fallback string', async () => {
    (generateContentMock as any).mockRejectedValue(new Error('Network error'));
    
    // Silence console error for this test
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await evaluator.evaluateComparison([], []);

    expect(result).toBe("Comparison evaluation failed due to an error.");
  });
});
