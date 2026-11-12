import { describe, it, expect } from '@jest/globals';
import { buildProbePlan, buildRequest, runCase, assessProbe, longInstruction, CANDIDATE_MODELS, ProbeResult, ProbeCase } from '../probe-models';
import { DISCOVERY_RESPONSE_SCHEMA } from '../../../adk/backend/src/agent';

describe('probe plan', () => {
  it('is 6 cases per candidate plus one plain call per judge that is not already a candidate: about 20', () => {
    const plan = buildProbePlan(CANDIDATE_MODELS, ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-4-argon']);
    expect(plan).toHaveLength(3 * 6 + 1);
    expect(plan.filter(p => p.kind === 'judge_plain').map(p => p.model)).toEqual(['gemini-2.5-pro']);
    expect(new Set(plan.map(p => p.id)).size).toBe(plan.length);
  });
});

describe('probe requests use the production settings', () => {
  const c = (kind: any): ProbeCase => ({ id: 'x', model: 'm', kind });
  it('the schema case uses GSR\'s real discovery schema object', () => {
    const r: any = buildRequest(c('schema'));
    expect(r.config.responseSchema).toBe(DISCOVERY_RESPONSE_SCHEMA);
    expect(r.config.responseMimeType).toBe('application/json');
    expect(r.config.maxOutputTokens).toBe(32768);
    expect('thinkingConfig' in r.config).toBe(false);
  });
  it('thinking cases send thinkingLevel, the dedup case sends thinkingBudget 4096', () => {
    expect((buildRequest(c('thinking_low')) as any).config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect((buildRequest(c('thinking_minimal')) as any).config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    expect((buildRequest(c('thinking_budget_4096')) as any).config.thinkingConfig).toEqual({ thinkingBudget: 4096 });
  });
  it('the small-cap case sets maxOutputTokens to 64 and nothing else that bounds thinking', () => {
    const r: any = buildRequest(c('max_output_small'));
    expect(r.config).toEqual({ maxOutputTokens: 64 });
  });
  it('the cache case uses an instruction comfortably over GSR\'s own 2048-token floor', () => {
    expect(buildRequest(c('caches_create'))).toEqual({ cache: true });
    expect(longInstruction().length).toBeGreaterThan(40_000); // ~4k+ tokens
  });
});

const fakeAi = (impl: { generate?: (req: any) => any; create?: (req: any) => any }) => ({
  models: { generateContent: async (req: any) => impl.generate!(req) },
  caches: { create: async (req: any) => impl.create!(req), delete: async () => ({}) },
}) as any;

describe('runCase', () => {
  const okJson = JSON.stringify({ filesAnalyzed: ['src/cache.ts'], issues: [] });
  it('records the served model, finish reason, usage and the residual that shows whether thoughts are separate', async () => {
    const ai = fakeAi({ generate: () => ({ modelVersion: 'gemini-4-argon', text: okJson, candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 150 } }) });
    const r = await runCase(ai, { id: 'a', model: 'gemini-4-argon', kind: 'schema' });
    expect(r).toMatchObject({ ok: true, servedModel: 'gemini-4-argon', servedMatches: true, finishReason: 'STOP', jsonParsed: true, jsonMatchesSchemaShape: true, usageResidual: 0 });
    expect(r.usage).toEqual({ prompt: 100, candidates: 20, thoughts: 30, total: 150, cached: undefined });
  });
  it('flags a served-model mismatch', async () => {
    const ai = fakeAi({ generate: () => ({ modelVersion: 'gemini-3.6-flash', text: okJson, usageMetadata: {} }) });
    expect((await runCase(ai, { id: 'a', model: 'gemini-3.5-flash', kind: 'schema' })).servedMatches).toBe(false);
  });
  it('captures an API rejection (e.g. 400 on MINIMAL) instead of throwing', async () => {
    const ai = fakeAi({ generate: () => { throw Object.assign(new Error('Thinking level MINIMAL is not supported'), { status: 400 }); } });
    const r = await runCase(ai, { id: 'a', model: 'gemini-3.8-flash', kind: 'thinking_minimal' });
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ status: 400, message: 'Thinking level MINIMAL is not supported' });
  });
  it('non-JSON output under a JSON schema is recorded as unparsed', async () => {
    const ai = fakeAi({ generate: () => ({ modelVersion: 'm', text: '{oops', usageMetadata: {} }) });
    const r = await runCase(ai, { id: 'a', model: 'm', kind: 'schema' });
    expect(r).toMatchObject({ ok: true, jsonParsed: false, jsonMatchesSchemaShape: false });
  });
  it('caches.create success is recorded and the cache deleted; rejection is recorded', async () => {
    expect((await runCase(fakeAi({ create: () => ({ name: 'cachedContents/abc' }) }), { id: 'c', model: 'm', kind: 'caches_create' })).cacheName).toBe('cachedContents/abc');
    const bad = await runCase(fakeAi({ create: () => { throw Object.assign(new Error('model does not support caching'), { status: 400 }); } }), { id: 'c', model: 'm', kind: 'caches_create' });
    expect(bad.ok).toBe(false);
  });
});

describe('assessProbe', () => {
  const r = (model: string, kind: any, over: Partial<ProbeResult> = {}): ProbeResult => ({ id: `${model}:${kind}`, model, kind, ok: true, servedMatches: true, jsonParsed: true, jsonMatchesSchemaShape: true, latencyMs: 1, ...over });
  const all = (model: string, over: Record<string, Partial<ProbeResult>> = {}) =>
    ['schema', 'thinking_budget_4096', 'thinking_low', 'thinking_minimal', 'caches_create', 'max_output_small'].map(k => r(model, k, over[k] ?? {}));

  it('keeps a model that has the must-haves, and records the nice-to-have failures as notes only', () => {
    const a = assessProbe(all('M', { thinking_minimal: { ok: false, error: { status: 400, message: 'no MINIMAL' } }, caches_create: { ok: false, error: { message: 'no cache' } } }), ['M'])[0];
    expect(a.dropped).toBe(false);
    expect(a.notes.join(' ')).toMatch(/MINIMAL rejected/);
    expect(a.notes.join(' ')).toMatch(/caches\.create rejected/);
    expect(a.supports.thinkingMinimal).toBe(false);
  });
  it('drops a model that cannot do structured JSON, or the deduplicator\'s thinkingBudget, or is served as something else', () => {
    expect(assessProbe(all('M', { schema: { ok: false, error: { message: 'schema rejected' } } }), ['M'])[0].dropped).toBe(true);
    expect(assessProbe(all('M', { schema: { jsonParsed: false } }), ['M'])[0].dropped).toBe(true);
    expect(assessProbe(all('M', { thinking_budget_4096: { ok: false, error: { message: 'budget invalid' } } }), ['M'])[0].dropped).toBe(true);
    const mm = assessProbe(all('M', { schema: { servedMatches: false, servedModel: 'other' } }), ['M'])[0];
    expect(mm.dropped).toBe(true);
    expect(mm.reasons.join(' ')).toMatch(/served as other/);
  });
  it('notes when a tiny output cap is consumed entirely by thinking', () => {
    const a = assessProbe(all('M', { max_output_small: { finishReason: 'MAX_TOKENS', textPreview: '' } }), ['M'])[0];
    expect(a.notes.join(' ')).toMatch(/consumed the cap/);
  });
  it('a model with no results at all is dropped, not silently kept', () => {
    expect(assessProbe([], ['M'])[0].dropped).toBe(true);
  });
});
