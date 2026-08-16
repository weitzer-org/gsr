// PR #61 self-review finding: the fix from parseFloat/parseInt to Number()
// in resolveFeedbackMinConfidence/resolveFeedbackMaxReplies had no
// dedicated regression test — a future refactor could silently reintroduce
// the permissive parsers with nothing to catch it. These tests enshrine the
// exact boundary behavior the fix exists for.
//
// Imported from feedbackConfig.ts, not action-entrypoint.ts — the latter's
// top-level `main().catch(...)` call runs on import (it's meant to be
// invoked as the Action's entrypoint script, not a library), which would
// otherwise run the whole Action and call process.exit(1) in this test
// environment. feedbackConfig.ts has no such side effect.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveFeedbackMinConfidence, resolveFeedbackMaxReplies } from '../src/feedbackConfig';

describe('resolveFeedbackMinConfidence', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Self-review finding pattern (matches feedbackLoop.test.ts /
    // adjudicator.test.ts): restore key-by-key, not via wholesale
    // reassignment, which loses process.env's special auto-stringification.
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('defaults to 0.7 when unset', () => {
    delete process.env.FEEDBACK_MIN_CONFIDENCE;
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
  });

  it('defaults to 0.7 for an empty/whitespace-only value', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '   ';
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
  });

  it('accepts a valid value within [0, 1]', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '0.85';
    expect(resolveFeedbackMinConfidence()).toBe(0.85);
  });

  it('accepts the boundary values 0 and 1', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '0';
    expect(resolveFeedbackMinConfidence()).toBe(0);
    process.env.FEEDBACK_MIN_CONFIDENCE = '1';
    expect(resolveFeedbackMinConfidence()).toBe(1);
  });

  it('rejects "0..7" — the exact typo this fix exists for — with a warning, falling back to 0.7 ' +
     '(regression test: parseFloat("0..7") silently returns 0, which is in-range and would have passed)', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '0..7';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('0..7'));
  });

  it('rejects trailing garbage like "0.7abc" (parseFloat would have silently accepted 0.7)', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '0.7abc';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Same ambiguity as the "3abc" test in resolveFeedbackMaxReplies below:
    // the rejected value's default (0.7) equals what a regressed parseFloat
    // would have parsed, so the warning call is the real proof this took
    // the rejection path, not the return value alone.
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('0.7abc'));
  });

  it('rejects an out-of-range value', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '1.5';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
  });

  it('rejects a negative value', () => {
    process.env.FEEDBACK_MIN_CONFIDENCE = '-0.1';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackMinConfidence()).toBe(0.7);
  });
});

describe('resolveFeedbackMaxReplies', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('defaults to 3 when unset', () => {
    delete process.env.FEEDBACK_MAX_REPLIES;
    expect(resolveFeedbackMaxReplies()).toBe(3);
  });

  it('accepts a valid non-negative integer', () => {
    process.env.FEEDBACK_MAX_REPLIES = '5';
    expect(resolveFeedbackMaxReplies()).toBe(5);
  });

  it('accepts 0', () => {
    process.env.FEEDBACK_MAX_REPLIES = '0';
    expect(resolveFeedbackMaxReplies()).toBe(0);
  });

  it('rejects a float like "3.5" — parseInt would have silently truncated to 3', () => {
    process.env.FEEDBACK_MAX_REPLIES = '3.5';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackMaxReplies()).toBe(3); // the DEFAULT 3, not a truncated 3 from "3.5"
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects trailing garbage like "3abc" — parseInt would have silently accepted 3', () => {
    process.env.FEEDBACK_MAX_REPLIES = '3abc';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Self-review note on this test itself: the rejected value (3) happens
    // to equal the default (3), so the return value alone can't distinguish
    // "correctly rejected, fell back to default" from "silently truncated
    // by a regressed parseInt" — the warning call is what actually proves
    // the rejection path ran.
    expect(resolveFeedbackMaxReplies()).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3abc'));
  });

  it('rejects a negative value', () => {
    process.env.FEEDBACK_MAX_REPLIES = '-1';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackMaxReplies()).toBe(3);
  });
});
