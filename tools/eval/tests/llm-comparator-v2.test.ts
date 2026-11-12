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

// --- Judge score matching under the per-PR slot swap (retrospective bug #8) ---
import { normalizeV2Metrics, resolveV2Metrics, compareResultsWithLLMV2, resolveJudgeModel, V2ComparisonMetrics } from '../llm-comparator-v2';

const T = (actionability: number, falsePositives = 0, uniqueFindings = 1) => ({ actionability, falsePositives, uniqueFindings });
const zero = { actionability: 0, falsePositives: 0, uniqueFindings: 0 };
const fallbackMetrics = (): V2ComparisonMetrics => ({
  targetA: { ...zero }, targetB: { ...zero }, gca: { ...zero }, codeRabbit: { ...zero },
  overlapMatrix: { targetA_targetB: 0, targetA_gca: 0, targetA_codeRabbit: 0, targetB_gca: 0, targetB_codeRabbit: 0, gca_codeRabbit: 0 },
});

describe('normalizeV2Metrics / resolveV2Metrics: label matching follows the labels actually passed in', () => {
  const X = T(9);
  const Y = T(3);

  it('REGRESSION: the exact reproduced case — swapped call, JSON keyed by display labels — no longer returns targetA === targetB', () => {
    // The judge was shown Production first (swapped), so targetA = "Production", targetB = "Local".
    const out = normalizeV2Metrics({ Production: X, Local: Y }, 'Production', 'Local', fallbackMetrics());
    expect(out.targetA).toBe(X);
    expect(out.targetB).toBe(Y);
    expect(out.targetA).not.toBe(out.targetB);
  });

  it('the un-swapped order resolves the same way', () => {
    const out = normalizeV2Metrics({ Local: Y, Production: X }, 'Local', 'Production', fallbackMetrics());
    expect(out.targetA).toBe(Y);
    expect(out.targetB).toBe(X);
  });

  it('is independent of the order of keys in the judge\'s JSON', () => {
    for (const raw of [{ Production: X, Local: Y }, { Local: Y, Production: X }]) {
      const out = normalizeV2Metrics(raw, 'Production', 'Local', fallbackMetrics());
      expect([out.targetA, out.targetB]).toEqual([X, Y]);
    }
  });

  it('matches labels case-insensitively but only against the labels passed in (arm names, not just local/production)', () => {
    const out = normalizeV2Metrics({ ARGON: X, base: Y }, 'argon', 'BASE', fallbackMetrics());
    expect(out.targetA).toBe(X);
    expect(out.targetB).toBe(Y);
  });

  it('does NOT fall back to the hard-coded local/production keys when the labels are something else', () => {
    const r = resolveV2Metrics({ local: X, production: Y }, 'Argon', 'Base', fallbackMetrics());
    expect(r.plausible).toBe(false);
    expect(r.reason).toMatch(/no score found for targetA/);
    expect(r.metrics.targetA).toEqual(zero); // fallback zeros, flagged — not another target's numbers
  });

  it('literal targetA/targetB keys win and stay plausible', () => {
    const r = resolveV2Metrics({ targetA: X, targetB: Y }, 'Production', 'Local', fallbackMetrics());
    expect(r.plausible).toBe(true);
    expect(r.metrics.targetA).toBe(X);
    expect(r.metrics.targetB).toBe(Y);
  });

  it('marks the result implausible when both targets resolve to the same object', () => {
    const shared = T(5);
    const r = resolveV2Metrics({ targetA: shared, targetB: shared }, 'A', 'B', fallbackMetrics());
    expect(r.plausible).toBe(false);
    expect(r.reason).toMatch(/same object/);
  });

  it('marks identical labels ambiguous (a key cannot identify a target)', () => {
    const r = resolveV2Metrics({ Base: X, base: Y }, 'Base', 'base', fallbackMetrics());
    expect(r.plausible).toBe(false);
    expect(r.reason).toMatch(/identical|more than one/);
  });

  it('marks a label that matches two keys ambiguous', () => {
    const r = resolveV2Metrics({ Local: X, LOCAL: Y, Production: T(1) }, 'Local', 'Production', fallbackMetrics());
    expect(r.plausible).toBe(false);
    expect(r.reason).toMatch(/more than one JSON key/);
  });

  it('missing JSON is implausible, not a zero-score tie', () => {
    const r = resolveV2Metrics(undefined, 'A', 'B', fallbackMetrics());
    expect(r.plausible).toBe(false);
  });
});

describe('compareResultsWithLLMV2 under a slot swap, end to end with a mocked judge', () => {
  const originalKey = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test_api_key';
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  });

  const finding = (n: number) => ({ fileName: 'a.ts', lineNumber: n, issueDescription: 'd', suggestion: 's', severity: 'HIGH', source: 'basic' });

  const run = async (judgeJson: object, labels: [string, string], model?: string) => {
    const generateContentMock = (jest.fn() as any).mockResolvedValue({
      text: 'report\n```json\n' + JSON.stringify(judgeJson) + '\n```',
      modelVersion: model ?? 'gemini-2.5-pro',
    });
    (GoogleGenAI as unknown as jest.Mock).mockImplementation(() => ({ models: { generateContent: generateContentMock } }));
    const res = await compareResultsWithLLMV2(
      'https://github.com/o/r/pull/1', [finding(1), finding(2), finding(3)], [finding(1)], [], [], labels[0], labels[1], model ? { model } : {}
    );
    return { res, generateContentMock };
  };

  it('a swapped call keyed by labels yields two DIFFERENT targets and stays plausible', async () => {
    const { res } = await run(
      { Production: T(9, 0, 1), Local: T(3, 1, 1), gca: T(0, 0, 0), codeRabbit: T(0, 0, 0), overlapMatrix: {} },
      ['Production', 'Local']
    );
    expect(res.plausible).toBe(true);
    expect(res.metrics.targetA.actionability).toBe(9);
    expect(res.metrics.targetB.actionability).toBe(3);
  });

  it('records the judge model asked for and the model that served it', async () => {
    const { res, generateContentMock } = await run(
      { targetA: T(5), targetB: T(5), gca: T(0, 0, 0), codeRabbit: T(0, 0, 0) }, ['A', 'B'], 'gemini-3.8-flash'
    );
    expect(generateContentMock.mock.calls[0][0].model).toBe('gemini-3.8-flash');
    expect(res.judgeModel).toBe('gemini-3.8-flash');
    expect(res.judgeServedModel).toBe('gemini-3.8-flash');
  });
});

describe('resolveJudgeModel', () => {
  it('defaults to gemini-2.5-pro, honours JUDGE_MODEL, and an explicit argument beats both', () => {
    expect(resolveJudgeModel(undefined, {})).toBe('gemini-2.5-pro');
    expect(resolveJudgeModel(undefined, { JUDGE_MODEL: 'gemini-3.8-flash' })).toBe('gemini-3.8-flash');
    expect(resolveJudgeModel('gemini-4-argon', { JUDGE_MODEL: 'gemini-3.8-flash' })).toBe('gemini-4-argon');
  });
});
