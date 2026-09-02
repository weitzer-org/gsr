import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveShadowMode, formatShadowReviewSummaryMarkdown } from '../src/shadowReview';
import { ReviewResult } from '../src/types';

describe('resolveShadowMode', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Restore key-by-key, matching this repo's other env-var tests
    // (action-entrypoint.test.ts, feedbackLoop.test.ts) — a wholesale
    // reassignment loses process.env's special auto-stringification.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('is off (undefined) when unset, with no warning — this is the default, common case', () => {
    delete process.env.SHADOW_MODE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveShadowMode('basic')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is off for an empty/whitespace-only value, with no warning', () => {
    process.env.SHADOW_MODE = '   ';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveShadowMode('basic')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns "subagent" when the primary mode is "basic"', () => {
    process.env.SHADOW_MODE = 'subagent';
    expect(resolveShadowMode('basic')).toBe('subagent');
  });

  it('returns "basic" when the primary mode is "subagent"', () => {
    process.env.SHADOW_MODE = 'basic';
    expect(resolveShadowMode('subagent')).toBe('basic');
  });

  it('is case/whitespace-insensitive, matching resolveFeedbackLoopMode\'s convention', () => {
    process.env.SHADOW_MODE = '  SubAgent  ';
    expect(resolveShadowMode('basic')).toBe('subagent');
  });

  it('warns and returns undefined for an unrecognized value', () => {
    process.env.SHADOW_MODE = 'deep';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveShadowMode('basic')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deep'));
  });

  it('warns and returns undefined when shadow-mode matches the primary mode (redundant)', () => {
    process.env.SHADOW_MODE = 'basic';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveShadowMode('basic')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('redundant'));
  });
});

describe('formatShadowReviewSummaryMarkdown', () => {
  function makeResult(findingsCount: number, calls: number, durationMs: number): ReviewResult {
    return {
      findings: Array.from({ length: findingsCount }, (_, i) => ({
        file: `f${i}.ts`, line: i + 1, severity: 'MEDIUM' as const, summary: 's', description: 'd',
      })),
      metrics: { inputTokens: 100, outputTokens: 50, calls, durationMs },
    };
  }

  it('names the shadow mode in the heading and states nothing was posted', () => {
    const md = formatShadowReviewSummaryMarkdown('basic', makeResult(2, 4, 5000), 'subagent', makeResult(5, 13, 20000), 'Evaluation text.');
    expect(md).toContain('## GSR Shadow Review (subagent)');
    expect(md).toContain('none of this was posted to the PR');
  });

  it('renders a comparison table with both modes\' finding/call/duration counts', () => {
    const md = formatShadowReviewSummaryMarkdown('basic', makeResult(2, 4, 5500), 'subagent', makeResult(5, 13, 20250), 'Evaluation text.');
    expect(md).toContain('Posted (`basic`)');
    expect(md).toContain('Shadow (`subagent`)');
    expect(md).toContain('| Findings | 2 | 5 |');
    expect(md).toContain('| Model calls | 4 | 13 |');
    // durationMs -> seconds, one decimal place
    expect(md).toContain('| Duration | 5.5s | 20.3s |');
  });

  it('includes the Evaluator comparison text verbatim', () => {
    const evaluationText = '**Subagent** found more critical issues.\n\n- point one\n- point two';
    const md = formatShadowReviewSummaryMarkdown('basic', makeResult(0, 0, 0), 'subagent', makeResult(0, 0, 0), evaluationText);
    expect(md).toContain(evaluationText);
  });

  it('works in the reverse direction too (subagent posting, basic shadow)', () => {
    const md = formatShadowReviewSummaryMarkdown('subagent', makeResult(5, 13, 20000), 'basic', makeResult(2, 4, 5000), 'Eval.');
    expect(md).toContain('## GSR Shadow Review (basic)');
    expect(md).toContain('Posted (`subagent`)');
    expect(md).toContain('Shadow (`basic`)');
  });
});
