// review-quality-design.md §7.3: generateAggregateReportV2 gained a new
// basicVsSubagentReports param so GSR's own internal subagent-vs-basic
// comparison (the Evaluator, §3.1) — previously buried inline in
// individualReports, targetA-only — gets a dedicated, explicitly-instructed
// section in the aggregate report prompt, with particular attention called
// out for Logic/Correctness findings (§1's weakest category). These tests
// only cover the prompt construction (the string sent to Gemini), not the
// LLM's actual output.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { generateAggregateReportV2 } from '../llm-comparator-v2';
import { GoogleGenAI } from '@google/genai';

// Same mocking pattern as tests/llm-comparator.test.ts.
jest.mock('@google/genai');
// trackGeminiCall (../usage) writes a usage record via storage.ts on every
// call — auto-mock storage.ts so that resolves to undefined instead of
// making a real S3 call in tests.
jest.mock('../storage');

describe('generateAggregateReportV2', () => {
  let generateContentMock: any;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test_api_key';

    // @ts-ignore
    generateContentMock = jest.fn().mockResolvedValue({ text: 'Aggregate summary.' });

    (GoogleGenAI as jest.Mock).mockImplementation(() => ({
      models: {
        generateContent: generateContentMock
      }
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const aggregateMetrics = { targetA: {}, targetB: {}, gca: {}, codeRabbit: {} };
  const llmAggregatedMetrics = { targetA: {}, targetB: {}, gca: {}, codeRabbit: {}, overlapMatrix: {} };

  it('includes a "(none recorded this run)" placeholder when no basic-vs-subagent reports are given', async () => {
    await generateAggregateReportV2(['PR report 1'], aggregateMetrics, 'Local', 'Production', llmAggregatedMetrics);

    const sentPrompt = generateContentMock.mock.calls[0][0].contents;
    expect(sentPrompt).toContain('<SUBAGENT_VS_BASIC_REPORTS>\n(none recorded this run)\n</SUBAGENT_VS_BASIC_REPORTS>');
  });

  it('also falls back to the placeholder when explicitly passed an empty array', async () => {
    await generateAggregateReportV2(['PR report 1'], aggregateMetrics, 'Local', 'Production', llmAggregatedMetrics, []);

    const sentPrompt = generateContentMock.mock.calls[0][0].contents;
    expect(sentPrompt).toContain('(none recorded this run)');
  });

  it('embeds the actual basic-vs-subagent report text when provided, and instructs a dedicated Logic/Correctness section', async () => {
    const reports = ['### Local (https://github.com/o/r/pull/1)\nSubagent found more Logic issues.'];
    await generateAggregateReportV2(['PR report 1'], aggregateMetrics, 'Local', 'Production', llmAggregatedMetrics, reports);

    const sentPrompt = generateContentMock.mock.calls[0][0].contents;
    expect(sentPrompt).toContain('Subagent found more Logic issues.');
    expect(sentPrompt).toContain('Subagent vs. Basic Mode');
    expect(sentPrompt.toLowerCase()).toContain('logic/correctness');
  });

  it('still includes the existing Metrics/Overlap Matrix instructions unchanged', async () => {
    await generateAggregateReportV2(['PR report 1'], aggregateMetrics, 'Local', 'Production', llmAggregatedMetrics);

    const sentPrompt = generateContentMock.mock.calls[0][0].contents;
    expect(sentPrompt).toContain('Metrics Comparison Matrix');
    expect(sentPrompt).toContain('Overlap Matrix');
  });

  it('returns the LLM response text', async () => {
    const result = await generateAggregateReportV2(['PR report 1'], aggregateMetrics, 'Local', 'Production', llmAggregatedMetrics);
    expect(result).toBe('Aggregate summary.');
  });
});
