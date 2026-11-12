import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_MODEL, resolveStageModel, resolveAllStageModels, resolveMaxOutputTokens, resolveThinkingLevel,
  generationOverrides, assertModelEnvValid, describeModelRouting, MODEL_STAGES,
} from '../src/models.js';
import { StageCollector } from '../src/stageMetrics.js';

describe('resolveStageModel: unset env is exactly today\'s behaviour', () => {
  it('every stage resolves to the default model with an empty environment', () => {
    for (const stage of MODEL_STAGES) expect(resolveStageModel(stage, {})).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('gemini-3.1-pro-preview');
  });

  it('GEMINI_MODEL moves discovery, remediation, basic and evaluate but NOT the deduplicator', () => {
    const env = { GEMINI_MODEL: 'gemini-3.8-flash' };
    expect(resolveStageModel('discovery', env)).toBe('gemini-3.8-flash');
    expect(resolveStageModel('remediation', env)).toBe('gemini-3.8-flash');
    expect(resolveStageModel('basic', env)).toBe('gemini-3.8-flash');
    expect(resolveStageModel('evaluate', env)).toBe('gemini-3.8-flash');
    expect(resolveStageModel('deduplicate', env)).toBe(DEFAULT_MODEL);
  });

  it('a stage variable beats GEMINI_MODEL, and only that stage', () => {
    const env = { GEMINI_MODEL: 'gemini-3.8-flash', DISCOVERY_MODEL: 'gemini-4-argon', DEDUPLICATOR_MODEL: 'gemini-4-argon' };
    expect(resolveAllStageModels(env)).toEqual({
      discovery: 'gemini-4-argon', remediation: 'gemini-3.8-flash', basic: 'gemini-3.8-flash',
      deduplicate: 'gemini-4-argon', evaluate: 'gemini-3.8-flash',
    });
  });

  it('treats an empty string as unset (matches the old `||` fallbacks)', () => {
    expect(resolveStageModel('discovery', { GEMINI_MODEL: '', DISCOVERY_MODEL: '' })).toBe(DEFAULT_MODEL);
  });
});

describe('GEMINI_MAX_OUTPUT_TOKENS / GEMINI_THINKING_LEVEL', () => {
  it('unset sends nothing at all', () => {
    expect(generationOverrides({})).toEqual({});
    expect(Object.keys(generationOverrides({}))).toHaveLength(0);
  });

  it('applies a positive integer cap and a thinking level', () => {
    expect(generationOverrides({ GEMINI_MAX_OUTPUT_TOKENS: '16384', GEMINI_THINKING_LEVEL: 'low' }))
      .toEqual({ maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: 'LOW' } });
  });

  it('accepts every level the SDK enum defines, case-insensitively', () => {
    for (const l of ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']) expect(resolveThinkingLevel({ GEMINI_THINKING_LEVEL: l.toLowerCase() })).toBe(l);
  });

  it('rejects junk instead of guessing', () => {
    for (const bad of ['0', '-5', '1.5', '12abc', ' ', 'NaN', '1e3']) {
      if (bad === ' ') continue;
      expect(resolveMaxOutputTokens({ GEMINI_MAX_OUTPUT_TOKENS: bad })).toBeUndefined();
    }
    expect(resolveThinkingLevel({ GEMINI_THINKING_LEVEL: 'EXTREME' })).toBeUndefined();
    expect(resolveThinkingLevel({ GEMINI_THINKING_LEVEL: '__proto__' })).toBeUndefined();
  });

  it('assertModelEnvValid throws on a set-but-invalid value and passes on unset/valid', () => {
    expect(() => assertModelEnvValid({})).not.toThrow();
    expect(() => assertModelEnvValid({ GEMINI_MAX_OUTPUT_TOKENS: '8192', GEMINI_THINKING_LEVEL: 'HIGH' })).not.toThrow();
    expect(() => assertModelEnvValid({ GEMINI_MAX_OUTPUT_TOKENS: 'lots' })).toThrow(/GEMINI_MAX_OUTPUT_TOKENS/);
    expect(() => assertModelEnvValid({ GEMINI_THINKING_LEVEL: 'EXTREME' })).toThrow(/GEMINI_THINKING_LEVEL/);
  });

  it('describeModelRouting reports the resolved routing for /api/status', () => {
    const d = describeModelRouting({ DISCOVERY_MODEL: 'gemini-4-argon', USE_CONTEXT_CACHING: 'false', GEMINI_MAX_OUTPUT_TOKENS: '9000' });
    expect(d.stageModels.discovery).toBe('gemini-4-argon');
    expect(d.stageModels.deduplicate).toBe(DEFAULT_MODEL);
    expect(d.maxOutputTokens).toBe(9000);
    expect(d.thinkingLevel).toBeNull();
    expect(d.contextCaching).toBe(false);
    expect(describeModelRouting({}).contextCaching).toBe(true);
  });
});

describe('StageCollector', () => {
  const rec = (over: any) => ({
    timestamp: 't', provider: 'gemini' as const, callType: 'discovery', model: 'gemini-4-argon', inputTokens: 10,
    outputTokens: 5, latencyMs: 100, costUsd: 0, success: true, ...over,
  });

  it('counts served models, mismatches, finish reasons, MAX_TOKENS, timeouts and parse failures per stage', () => {
    const c = new StageCollector();
    c.observe(rec({ servedModel: 'gemini-4-argon', finishReason: 'STOP' }));
    c.observe(rec({ servedModel: 'gemini-3.6-flash', model: 'gemini-3.5-flash', finishReason: 'MAX_TOKENS' }));
    c.observe(rec({ success: false, errorKind: 'timeout' }));
    c.observe(rec({ callType: 'deduplicate', servedModel: 'models/gemini-3.1-pro-preview', model: 'gemini-3.1-pro-preview' }));
    c.timeout('discovery', 'gemini-4-argon');
    const s = c.summary();
    expect(s.discovery.calls).toBe(3);
    expect(s.discovery.successes).toBe(2);
    expect(s.discovery.failures).toBe(1);
    expect(s.discovery.servedModels).toEqual({ 'gemini-4-argon': 1, 'gemini-3.6-flash': 1 });
    expect(s.discovery.servedModelMismatches).toBe(1);
    expect(s.discovery.maxTokens).toBe(1);
    expect(s.discovery.timeouts).toBe(2); // errorKind timeout + the client-side ETIMEDOUT
    expect(s.discovery.errorKinds).toEqual({ timeout: 1, client_timeout: 1 });
    expect(s.deduplicate.servedModelMismatches).toBe(0); // "models/" prefix is not a mismatch
  });

  it('a parse-failure record annotates the call already counted: it adds parseFailures and nothing else', () => {
    const c = new StageCollector();
    // trackGeminiCall records the call as a success first...
    c.observe(rec({ servedModel: 'gemini-4-argon', finishReason: 'MAX_TOKENS', inputTokens: 100, outputTokens: 50, thinkingTokens: 7, latencyMs: 900 }));
    // ...then recordParseFailure writes a second record carrying the same numbers.
    c.observe(rec({ success: false, errorKind: 'parse_error', servedModel: 'gemini-4-argon', finishReason: 'MAX_TOKENS', inputTokens: 100, outputTokens: 50, thinkingTokens: 7, latencyMs: 900 }));
    const s = c.summary().discovery;
    expect(s.calls).toBe(1);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.parseFailures).toBe(1);
    expect(s.maxTokens).toBe(1);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
    expect(s.thinkingTokens).toBe(7);
    expect(s.latencyMs).toEqual([900]);
    expect(s.finishReasons).toEqual({ MAX_TOKENS: 1 });
    expect(s.servedModels).toEqual({ 'gemini-4-argon': 1 });
  });

  it('counts a successful call with no modelVersion as unreported, never as a match', () => {
    const c = new StageCollector();
    c.observe(rec({}));
    const s = c.summary().discovery;
    expect(s.servedModelUnreported).toBe(1);
    expect(s.servedModelMismatches).toBe(0);
    expect(s.servedModels).toEqual({});
  });

  it('is not poisoned by __proto__ keys', () => {
    const c = new StageCollector();
    c.observe(rec({ finishReason: '__proto__', servedModel: '__proto__' }));
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(c.summary().discovery.finishReasons)).toHaveLength(0);
  });
});
