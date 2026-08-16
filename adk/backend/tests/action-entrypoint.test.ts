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
import { resolveFeedbackMinConfidence, resolveFeedbackMaxReplies, resolveFeedbackPostEnabled, feedbackPostMisconfigurationWarning, resolveFeedbackReportConfig } from '../src/feedbackConfig';

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

// Phase 2b's arm switch (see feedbackLoop.ts's module doc comment for why
// this is a separate opt-in rather than a new feedback-loop mode value).
describe('resolveFeedbackPostEnabled', () => {
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

  it('defaults to false when unset — real posting never turns itself on', () => {
    delete process.env.FEEDBACK_POST;
    expect(resolveFeedbackPostEnabled()).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    process.env.FEEDBACK_POST = 'true';
    expect(resolveFeedbackPostEnabled()).toBe(true);
  });

  it('is case/whitespace-insensitive, matching resolveFeedbackLoopMode\'s convention', () => {
    process.env.FEEDBACK_POST = '  TRUE  ';
    expect(resolveFeedbackPostEnabled()).toBe(true);
  });

  it('is false for the exact string "false"', () => {
    process.env.FEEDBACK_POST = 'false';
    expect(resolveFeedbackPostEnabled()).toBe(false);
  });

  it('fails closed (false) on any unrecognized value, with a warning — this switch is too consequential to guess', () => {
    process.env.FEEDBACK_POST = 'yes';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFeedbackPostEnabled()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('yes'));
  });
});

describe('feedbackPostMisconfigurationWarning', () => {
  it('warns when feedback-post is true but feedback-loop is "off"', () => {
    expect(feedbackPostMisconfigurationWarning('off', true)).toContain('feedback-post is "true"');
  });

  it('warns when feedback-post is true but feedback-loop is "observe"', () => {
    expect(feedbackPostMisconfigurationWarning('observe', true)).toContain('feedback-post is "true"');
  });

  it('does not warn when feedback-post is true and feedback-loop is "respond" (the only combination that does anything)', () => {
    expect(feedbackPostMisconfigurationWarning('respond', true)).toBeUndefined();
  });

  it('does not warn when feedback-post is false, regardless of mode', () => {
    expect(feedbackPostMisconfigurationWarning('off', false)).toBeUndefined();
    expect(feedbackPostMisconfigurationWarning('observe', false)).toBeUndefined();
    expect(feedbackPostMisconfigurationWarning('respond', false)).toBeUndefined();
  });
});

// Phase 3 ("report") — mirrors maybeReportUsage's config resolution: no-ops
// (returns null) unless BOTH env vars are set, same custody model as
// usage-report-url/usage-report-key.
describe('resolveFeedbackReportConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('returns null when neither is set', () => {
    delete process.env.FEEDBACK_REPORT_URL;
    delete process.env.FEEDBACK_SHARED_SECRET;
    expect(resolveFeedbackReportConfig()).toBeNull();
  });

  it('returns null when only the URL is set', () => {
    process.env.FEEDBACK_REPORT_URL = 'https://gsr-code-review.fly.dev/api/findings/feedback';
    delete process.env.FEEDBACK_SHARED_SECRET;
    expect(resolveFeedbackReportConfig()).toBeNull();
  });

  it('returns null when only the key is set', () => {
    delete process.env.FEEDBACK_REPORT_URL;
    process.env.FEEDBACK_SHARED_SECRET = 'secret';
    expect(resolveFeedbackReportConfig()).toBeNull();
  });

  it('returns the config when both are set', () => {
    process.env.FEEDBACK_REPORT_URL = 'https://gsr-code-review.fly.dev/api/findings/feedback';
    process.env.FEEDBACK_SHARED_SECRET = 'secret';
    expect(resolveFeedbackReportConfig()).toEqual({
      url: 'https://gsr-code-review.fly.dev/api/findings/feedback',
      key: 'secret',
    });
  });
});
