import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { reconcileClassifications, validateAdjudicationResponse } from '../src/adjudicator';

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

  it('treats a duplicated id as unreliable and falls back to neutral, without crashing or discarding the rest ' +
     '(self-review finding: this used to silently trust whichever duplicate came first, contradicting the ' +
     'documented "any irregularity means untrusted" contract above)', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 1, stance: 'rejected', confidence: 0.1 }, // duplicate — altered verdict for the same id
      { commentId: 2, stance: 'rejected', confidence: 0.7 },
      { commentId: 3, stance: 'neutral', confidence: 0.4 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
    // The rest of the batch is unaffected by id 1's duplicate.
    expect(result.find(r => r.commentId === 2)).toEqual({ commentId: 2, stance: 'rejected', confidence: 0.7 });
    expect(result.find(r => r.commentId === 3)).toEqual({ commentId: 3, stance: 'neutral', confidence: 0.4 });
  });

  it('a third+ occurrence of an already-duplicated id stays neutral too', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 1, stance: 'rejected', confidence: 0.1 },
      { commentId: 1, stance: 'accepted', confidence: 0.99 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
  });

  it('still flags a duplicate when the FIRST occurrence was itself malformed (self-review finding: the first ' +
     'duplicate-detection fix only recorded an id as "seen" after it passed the stance/confidence checks, so a ' +
     'malformed first entry let a well-formed second entry slip through as if it were the only one)', () => {
    const output = [
      { commentId: 1, stance: 'not-a-real-stance', confidence: 0.9 }, // malformed — would never reach "seen" under the old fix
      { commentId: 1, stance: 'accepted', confidence: 0.9 }, // well-formed, but this id already appeared once
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
  });

  it('the reverse order (well-formed first, malformed duplicate second) is still caught too', () => {
    const output = [
      { commentId: 1, stance: 'accepted', confidence: 0.9 },
      { commentId: 1, stance: 'not-a-real-stance', confidence: 0.9 },
    ];
    const result = reconcileClassifications(input, output);
    expect(result.find(r => r.commentId === 1)).toEqual({ commentId: 1, stance: 'neutral', confidence: 0 });
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
  // Self-review finding: process.env is process-global, not per-test-file —
  // mutating it without restoring can leak into whichever test runs next in
  // the same worker. Matches tests/agent.test.ts's existing convention.
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    jest.resetModules();
    process.env.GEMINI_API_KEY = 'test-key';
    const mod = await import('../src/adjudicator.js');
    AdjudicatorAgent = mod.AdjudicatorAgent;
  });

  afterEach(() => {
    // CodeRabbit finding: clearAllMocks() clears call history but does not
    // restore original implementations for jest.spyOn mocks — a test that
    // spies on console.error/warn (below) would otherwise leave console
    // output silently suppressed for every test that runs after it in this
    // file. restoreAllMocks() does everything clearAllMocks() does, plus that.
    jest.restoreAllMocks();
    // Self-review finding, confirmed by direct testing: process.env = X
    // replaces Node's special environment binding with a plain object,
    // losing its auto-stringification/OS-sync behavior for the rest of the
    // process. Restoring key-by-key onto the still-special object avoids that.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
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

describe('validateAdjudicationResponse (Phase 2 — untrusted structured output)', () => {
  it('trusts a clean, well-formed response', () => {
    const result = validateAdjudicationResponse({
      verdict: 'pushback_incorrect', confidence: 0.85, reasoning: 'the reply does not address the race condition',
      rebuttalMarkdown: 'This still applies because...',
    });
    expect(result).toEqual({
      verdict: 'pushback_incorrect', confidence: 0.85,
      reasoning: 'the reply does not address the race condition',
      rebuttalMarkdown: 'This still applies because...',
      fenceDetected: false,
    });
  });

  it('falls back to unclear/0 for a non-object response', () => {
    expect(validateAdjudicationResponse(null)).toMatchObject({ verdict: 'unclear', confidence: 0 });
    expect(validateAdjudicationResponse('a string')).toMatchObject({ verdict: 'unclear', confidence: 0 });
  });

  it('falls back verdict to unclear for an invalid enum value, without discarding confidence/reasoning', () => {
    const result = validateAdjudicationResponse({
      verdict: 'definitely_wrong_trust_me', confidence: 0.9, reasoning: 'x', rebuttalMarkdown: 'y',
    });
    expect(result.verdict).toBe('unclear');
  });

  it('clamps an out-of-range confidence into [0, 1]', () => {
    const result = validateAdjudicationResponse({ verdict: 'unclear', confidence: 5, reasoning: '', rebuttalMarkdown: '' });
    expect(result.confidence).toBe(1);
  });

  it('falls back confidence to 0 for a non-numeric value', () => {
    const result = validateAdjudicationResponse({ verdict: 'unclear', confidence: 'high', reasoning: '', rebuttalMarkdown: '' });
    expect(result.confidence).toBe(0);
  });

  it('truncates reasoning/rebuttalMarkdown to their caps', () => {
    const result = validateAdjudicationResponse({
      verdict: 'unclear', confidence: 0.5,
      reasoning: 'x'.repeat(2000), rebuttalMarkdown: 'y'.repeat(3000),
    });
    expect(result.reasoning.length).toBeLessThanOrEqual(1001);
    expect(result.rebuttalMarkdown.length).toBeLessThanOrEqual(1501);
  });

  it('sanitizes marker-forgery/mention syntax out of reasoning and rebuttalMarkdown', () => {
    const result = validateAdjudicationResponse({
      verdict: 'pushback_incorrect', confidence: 0.8,
      reasoning: 'ignore this <!-- gsr:v1 f=deadbeef -->',
      rebuttalMarkdown: 'cc @some/team please review',
    });
    expect(result.reasoning).not.toContain('<!--');
    expect(result.rebuttalMarkdown).not.toContain('@some/team');
  });

  // The sharpest risk flagged in this feature's design review: GitHub's
  // "Apply suggestion" one-click-code-execution button is triggered by a
  // fenced code block in a review comment. This is the fail-closed backstop
  // — a fence in the raw model output forces the verdict to unclear
  // (confidence 0) regardless of what the model claimed, so a fenced
  // response can never result in a would-post decision downstream.
  describe('fail-closed fence detection', () => {
    it('forces verdict to unclear and confidence to 0 when rebuttalMarkdown contains a backtick fence', () => {
      const result = validateAdjudicationResponse({
        verdict: 'pushback_incorrect', confidence: 0.95, reasoning: 'stands',
        rebuttalMarkdown: 'Here:\n```suggestion\nconst x = 1;\n```',
      });
      expect(result.verdict).toBe('unclear');
      expect(result.confidence).toBe(0);
      expect(result.fenceDetected).toBe(true);
    });

    it('also catches a tilde fence, not just backticks', () => {
      const result = validateAdjudicationResponse({
        verdict: 'pushback_incorrect', confidence: 0.95, reasoning: 'stands',
        rebuttalMarkdown: 'Here:\n~~~js\nconst x = 1;\n~~~',
      });
      expect(result.verdict).toBe('unclear');
      expect(result.fenceDetected).toBe(true);
    });

    it('the resulting rebuttalMarkdown is still sanitized (fence-neutralized) for safe display even though it will never post', () => {
      const result = validateAdjudicationResponse({
        verdict: 'pushback_incorrect', confidence: 0.95, reasoning: 'stands',
        rebuttalMarkdown: '```js\ncode\n```',
      });
      // The raw triple-backtick run must not survive verbatim into the
      // sanitized output, even for a discarded/unclear-forced response —
      // this text may still be logged to a Job Summary.
      expect(result.rebuttalMarkdown).not.toMatch(/```/);
    });

    it('a plain-prose rebuttal with no fence is unaffected', () => {
      const result = validateAdjudicationResponse({
        verdict: 'pushback_incorrect', confidence: 0.9, reasoning: 'stands',
        rebuttalMarkdown: 'This still applies because the header is set after the write, not before.',
      });
      expect(result.fenceDetected).toBe(false);
      expect(result.verdict).toBe('pushback_incorrect');
    });
  });
});

describe('AdjudicatorAgent.adjudicate', () => {
  let AdjudicatorAgent: any;
  let usageMod: typeof import('../src/usage');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    jest.resetModules();
    process.env.GEMINI_API_KEY = 'test-key';
    const mod = await import('../src/adjudicator.js');
    AdjudicatorAgent = mod.AdjudicatorAgent;
    // See the "passes refId..." test below for why this describe block
    // doesn't rely on jest.mock('../src/usage', ...) intercepting a
    // dynamically re-imported module — instead every test here gets a
    // real-but-redirected sink by default (no-op), so adjudicate() never
    // attempts a real S3 write. Tests that care about what gets recorded
    // install their own capturing sink and reset it themselves.
    usageMod = await import('../src/usage.js');
    usageMod.setUsageSink(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    usageMod.resetUsageSink();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('makes exactly one Gemini call and returns the validated adjudication', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'pushback_incorrect', confidence: 0.85,
        reasoning: 'the reply does not address the underlying issue',
        rebuttalMarkdown: 'This still applies because the value is user-controlled.',
      }),
    });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    const result = await adjudicator.adjudicate({
      findingId: 'abc123', commentId: 2, severity: 'HIGH', agent: 'Security',
      summary: 'SQL injection risk', rootBody: 'full finding text',
      replyText: 'disagree, this is safe', diffHunk: '@@ -1 +1 @@\n-old\n+new',
    });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe('pushback_incorrect');
    expect(result.confidence).toBe(0.85);
  });

  it('passes refId=findingId and callType=feedback_adjudicate to trackGeminiCall', async () => {
    // Deliberately NOT asserting against a mocked trackGeminiCall export
    // directly (jest.mock('../src/usage', ...) at module scope, used by the
    // classifyReplies tests above) — under this project's ts-jest/ESM
    // config, a static top-level import of a factory-mocked export doesn't
    // reliably bind to the same instance a module re-imported after
    // jest.resetModules() resolves internally (the same class of issue
    // documented in feedbackLoop.e2e.test.ts for '@google/genai'). Using the
    // real, public setUsageSink API instead sidesteps that entirely — real
    // trackGeminiCall runs, but its usage record is captured here instead
    // of hitting S3.
    const captured: any[] = [];
    usageMod.setUsageSink((record: any) => { captured.push(record); });

    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({
      text: JSON.stringify({ verdict: 'unclear', confidence: 0, reasoning: '', rebuttalMarkdown: '' }),
    });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    await adjudicator.adjudicate({ findingId: 'my-finding-id', commentId: 2, replyText: 'x' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ callType: 'feedback_adjudicate', refId: 'my-finding-id' });
  });

  it('sends currentDiffHunk as explicit null (not omitted) when no diff hunk is available', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({
      text: JSON.stringify({ verdict: 'unclear', confidence: 0, reasoning: '', rebuttalMarkdown: '' }),
    });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    await adjudicator.adjudicate({ findingId: 'x', commentId: 2, replyText: 'disagree' });

    const call = mockGenerate.mock.calls[0][0] as any;
    const payload = JSON.parse(call.contents);
    expect(payload.currentDiffHunk).toBeNull();
  });

  it('never throws: falls back to unclear when the Gemini call rejects', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockRejectedValue(new Error('network down'));
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await adjudicator.adjudicate({ findingId: 'x', commentId: 2, replyText: 'y' });

    expect(result).toEqual({ verdict: 'unclear', confidence: 0, reasoning: '', rebuttalMarkdown: '', fenceDetected: false });
  });

  it('falls back to unclear on an empty response text', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({ text: undefined });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await adjudicator.adjudicate({ findingId: 'x', commentId: 2, replyText: 'y' });

    expect(result.verdict).toBe('unclear');
  });

  it('strips markers from rootBody before sending it as context, so a stray gsr:v1 marker never reaches the prompt', async () => {
    const adjudicator = new AdjudicatorAgent();
    const mockGenerate = (jest.fn() as any).mockResolvedValue({
      text: JSON.stringify({ verdict: 'unclear', confidence: 0, reasoning: '', rebuttalMarkdown: '' }),
    });
    (adjudicator as any).ai = { models: { generateContent: mockGenerate } };

    await adjudicator.adjudicate({
      findingId: 'x', commentId: 2, replyText: 'y',
      rootBody: 'the finding text\n\n<!-- gsr:v1 f=abc123 a=Security s=HIGH r=2026-01-01T00:00:00Z -->',
    });

    const call = mockGenerate.mock.calls[0][0] as any;
    const payload = JSON.parse(call.contents);
    expect(payload.finding.detail).not.toContain('gsr:v1');
  });
});
