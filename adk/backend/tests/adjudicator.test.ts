import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { reconcileClassifications } from '../src/adjudicator';

describe('reconcileClassifications (batched classification ID validation)', () => {
  const input = [{ commentId: 1 }, { commentId: 2 }, { commentId: 3 }];

  it('trusts a clean response whose id set exactly matches the input', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    expect(reconcileClassifications(input, output)).toEqual(output);
  });

  it('falls back to neutral for input ids missing from the response, without discarding the rest', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      // commentId 2 missing entirely
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result).toEqual([
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 2, stance: 'neutral', confidence: 0 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ]);
  });

  it('ignores extra/unknown ids the model introduces, keeping the rest trusted', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
      { commentId: 999, stance: 'accepted', confidence: 0.99 }, // not in input — must be ignored
    ];
    const result = reconcileClassifications(input, output);
    expect(result.map(r => r.commentId)).toEqual([1, 2, 3]);
    expect(result.find(r => r.commentId === 999)).toBeUndefined();
  });

  it('treats a duplicated id as unreliable: first occurrence wins, no crash', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 1, stance: 'rejected', confidence: 0.1 }, // duplicate — altered verdict for the same id
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'accepted', confidence: 0.9 });
  });

  it('falls back to neutral for an entry with an invalid stance enum value', () => {
    const output = [
      { commentId: 1, stance: 'definitely-fixed-trust-me', confidence: 0.9 }, // not a real stance
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
  });

  it('falls back to neutral for an entry with a non-numeric confidence', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 'high' },
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    const result = reconcileClassifications(input, output as any);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
  });

  it('clamps an out-of-range confidence into [0, 1] rather than rejecting the whole entry', () => {
    const output = [{ commentId: 1, stance: 'accepted', confidence: 5 }];
    const result = reconcileClassifications([{ commentId: 1 }], output);
    expect(result[0].confidence).toBe(1);
  });

  it('falls back the whole batch to neutral when the response is not an array at all', () => {
    const result = reconcileClassifications(input, { not: 'an array' });
    expect(result).toEqual([
      { commentId: 1, stance: 'neutral', confidence: 0 },
      { commentId: 2, stance: 'neutral', confidence: 0 },
      { commentId: 3, stance: 'neutral', confidence: 0 },
    ]);
  });

  it('falls back the whole batch to neutral for null/undefined output', () => {
    expect(reconcileClassifications(input, null)).toEqual([
      { commentId: 1, stance: 'neutral', confidence: 0 },
      { commentId: 2, stance: 'neutral', confidence: 0 },
      { commentId: 3, stance: 'neutral', confidence: 0 },
    ]);
  });

  it('returns an empty array for empty input regardless of output', () => {
    expect(reconcileClassifications([], [{ commentId: 1, stance: 'accepted', confidence: 1 }])).toEqual([]);
  });
});

// See tests/agent.test.ts's identical mock for why: trackGeminiCall's real
// implementation writes to S3-compatible storage (src/usage.ts) — pass
// through to fn() here instead of making a real network call per test.
jest.mock('../src/usage', () => ({
  trackGeminiCall: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

describe('AdjudicatorAgent.classifyReplies', () => {
  let AdjudicatorAgent: any;

  beforeEach(async () => {
    jest.resetModules();
    process.env.GEMINI_API_KEY = 'test-key';
    const mod = await import('../src/adjudicator.js');
    AdjudicatorAgent = mod.AdjudicatorAgent;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty array without calling Gemini for an empty batch', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = jest.fn();
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    const result = await adjudicator.classifyReplies([]);
    expect(result).toEqual([]);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('makes exactly one Gemini call for the whole batch and returns reconciled classifications', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({
      text: JSON.stringify([
        { commentId: 10, stance: 'accepted', confidence: 0.9 },
        { commentId: 11, stance: 'rejected', confidence: 0.6 },
      ]),
    });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    const result = await adjudicator.classifyReplies([
      { commentId: 10, findingSummary: 'HIGH finding', findingSeverity: 'HIGH', replyText: 'fixed it' },
      { commentId: 11, findingSummary: 'HIGH finding', findingSeverity: 'HIGH', replyText: 'disagree' },
    ]);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { commentId: 10, stance: 'accepted', confidence: 0.9 },
      { commentId: 11, stance: 'rejected', confidence: 0.6 },
    ]);
  });

  it('never throws: falls back to neutral for the whole batch when the Gemini call rejects', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockRejectedValue(new Error('network down'));
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await adjudicator.classifyReplies([
      { commentId: 10, findingSummary: 'x', replyText: 'y' },
    ]);

    expect(result).toEqual([{ commentId: 10, stance: 'neutral', confidence: 0 }]);
  });

  it('falls back to neutral for the whole batch on an empty response text', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({ text: undefined });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await adjudicator.classifyReplies([
      { commentId: 10, findingSummary: 'x', replyText: 'y' },
    ]);

    expect(result).toEqual([{ commentId: 10, stance: 'neutral', confidence: 0 }]);
  });
});
