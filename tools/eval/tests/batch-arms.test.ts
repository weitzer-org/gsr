import { describe, it, expect, afterAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateArms, loadArms, buildBackendEnv, resolveArmRouting, assertExplicitRouting, assertParity, diffRoutingAgainstStatus, ArmConfig,
} from '../arms';
import {
  prSlug, sizeClassOf, loadBatch, writeJson, assertSameBatch, BatchMismatchError, classifyCompleteAttempt, classifyFailure,
  stageServedMismatches, stageFlagCounts, costOfMetrics, runFileName, newBatchId, RunRecord, Manifest,
} from '../batch';
import { CallBudget, BudgetExceededError, requireCap } from '../budget';

const arms = loadArms(path.join(__dirname, '..', 'arms', 'model-upgrade.json'));

describe('the pre-registered arms file', () => {
  it('has the five arms, one baseline, one control', () => {
    expect(arms.map(a => a.name)).toEqual(['BASE', 'BASE2', 'ARGON', 'FLASH38', 'FLASH38_LOW']);
    expect(arms.filter(a => a.role === 'baseline').map(a => a.name)).toEqual(['BASE']);
    expect(arms.filter(a => a.role === 'control').map(a => a.name)).toEqual(['BASE2']);
  });

  it('sets every stage explicitly, with caching off and the same output cap everywhere', () => {
    expect(() => assertExplicitRouting(arms)).not.toThrow();
    expect(() => assertParity(arms)).not.toThrow();
  });

  it('resolves to exactly the models the plan names, dedup included, and only FLASH38_LOW has a thinking level', () => {
    const route = (n: string) => resolveArmRouting(arms.find(a => a.name === n)!, { GEMINI_MODEL: 'leftover-from-my-shell' });
    for (const [name, model] of [['BASE', 'gemini-3.1-pro-preview'], ['BASE2', 'gemini-3.1-pro-preview'], ['ARGON', 'gemini-4-argon'], ['FLASH38', 'gemini-3.8-flash'], ['FLASH38_LOW', 'gemini-3.8-flash']]) {
      expect(Object.values(route(name).stageModels)).toEqual(Array(5).fill(model));
    }
    expect(route('FLASH38_LOW').thinkingLevel).toBe('LOW');
    expect(route('FLASH38').thinkingLevel).toBeNull();
    expect(route('BASE').maxOutputTokens).toBe(32768);
    expect(route('BASE').contextCaching).toBe(false);
  });

  it('BASE and BASE2 are identical configs (an A/A pair)', () => {
    expect(arms[0].env).toEqual(arms[1].env);
  });
});

describe('arm validation', () => {
  const mk = (over: Partial<ArmConfig>[]): ArmConfig[] => over.map((o, i) => ({ name: `A${i}`, env: {}, ...o }) as ArmConfig);
  it('rejects secrets / unknown keys in an overlay (the overlay is written into manifest.json)', () => {
    expect(() => validateArms(mk([{ role: 'baseline' }, { env: { GEMINI_API_KEY: 'x' } }]))).toThrow(/not allowed/);
    expect(() => validateArms(mk([{ role: 'baseline' }, { env: { S3_SECRET_ACCESS_KEY: 'x' } }]))).toThrow(/not allowed/);
  });
  it('needs exactly one baseline, unique names, and sane names', () => {
    expect(() => validateArms(mk([{}, {}]))).toThrow(/baseline/);
    expect(() => validateArms(mk([{ role: 'baseline', name: 'X' }, { name: 'X' }]))).toThrow(/Duplicate/);
    expect(() => validateArms(mk([{ role: 'baseline', name: 'bad name' }, {}]))).toThrow(/must match/);
  });
  it('assertParity flags a differing output cap; assertExplicitRouting flags an unset stage and caching on', () => {
    const [a, b] = JSON.parse(JSON.stringify(arms)) as ArmConfig[];
    b.env.GEMINI_MAX_OUTPUT_TOKENS = '1000';
    expect(() => assertParity([a, b])).toThrow(/GEMINI_MAX_OUTPUT_TOKENS differs/);
    const c = JSON.parse(JSON.stringify(arms[0])) as ArmConfig;
    delete c.env.DEDUPLICATOR_MODEL;
    expect(() => assertExplicitRouting([c])).toThrow(/DEDUPLICATOR_MODEL/);
    const d = JSON.parse(JSON.stringify(arms[0])) as ArmConfig;
    d.env.USE_CONTEXT_CACHING = 'true';
    expect(() => assertExplicitRouting([d])).toThrow(/USE_CONTEXT_CACHING/);
  });
});

describe('buildBackendEnv', () => {
  it('scrubs inherited tunables and ABLATE_*, applies the overlay, sets the port, and keeps secrets for the child', () => {
    const parent = { GEMINI_API_KEY: 'k', GITHUB_TOKEN: 't', GEMINI_MODEL: 'stale', DISCOVERY_MODEL: 'stale', ABLATE_LOGIC: 'true', UI_PASSWORD: 'p', PATH: '/bin' };
    const env = buildBackendEnv(parent, arms[2], 8103);
    expect(env.GEMINI_MODEL).toBeUndefined();
    expect(env.ABLATE_LOGIC).toBeUndefined();
    expect(env.UI_PASSWORD).toBeUndefined();
    expect(env.DISCOVERY_MODEL).toBe('gemini-4-argon');
    expect(env.PORT).toBe('8103');
    expect(env.GEMINI_API_KEY).toBe('k');
    expect(env.PATH).toBe('/bin');
    expect(parent.GEMINI_MODEL).toBe('stale'); // the parent object is not mutated
  });
});

describe('diffRoutingAgainstStatus', () => {
  it('is empty when the server reports what was expected and names each disagreement otherwise', () => {
    const expected = resolveArmRouting(arms[2]);
    expect(diffRoutingAgainstStatus(expected, { ...expected })).toEqual([]);
    const bad = { ...expected, stageModels: { ...expected.stageModels, deduplicate: 'gemini-3.1-pro-preview' } };
    const problems = diffRoutingAgainstStatus(expected, bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/deduplicate/);
    expect(diffRoutingAgainstStatus(expected, {})).not.toEqual([]); // an old server with no stageModels fails loudly
  });
});

const tmpDirs: string[] = [];
const mkTmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('batch helpers', () => {
  it('prSlug / sizeClassOf', () => {
    expect(prSlug('https://github.com/weitzer-org/gsr/pull/50')).toBe('weitzer-org__gsr__pull-50');
    expect(() => prSlug('https://example.com/x')).toThrow();
    expect(sizeClassOf(9)).toBe('small');
    expect(sizeClassOf(10)).toBe('large');
    expect(runFileName('a', 2, 'ARGON')).toBe('a__rep2__ARGON.json');
    expect(newBatchId(new Date('2026-11-12T01:02:03.456Z'))).toBe('batch-2026-11-12T01-02-03-456Z');
  });

  it('loadBatch refuses a run file from another batch', () => {
    const dir = mkTmp('batch-');
    const manifest = { schema: 1, batch_id: 'batch-A', arms: [], prs: [] } as unknown as Manifest;
    writeJson(path.join(dir, 'manifest.json'), manifest);
    const run = (batch_id: string): RunRecord => ({ schema: 1, batch_id, arm: 'BASE', pr: 'u', pr_slug: 's', rep: 1, attempts: [], first_attempt_complete: true, first_attempt_clean: true, retries: 0, accepted_attempt: 1, result: null });
    writeJson(path.join(dir, 'runs', 's__rep1__BASE.json'), run('batch-A'));
    expect(loadBatch(dir).runs).toHaveLength(1);
    writeJson(path.join(dir, 'runs', 's__rep1__ARGON.json'), run('batch-B'));
    expect(() => loadBatch(dir)).toThrow(BatchMismatchError);
    expect(() => assertSameBatch('judge record', 'batch-A', 'batch-B')).toThrow(/different batches/);
    expect(() => assertSameBatch('judge record', 'batch-A', 'batch-A')).not.toThrow();
  });

  it('loadBatch needs a manifest with a batch_id', () => {
    const dir = mkTmp('batch-');
    expect(() => loadBatch(dir)).toThrow(/manifest/);
    writeJson(path.join(dir, 'manifest.json'), { schema: 1 });
    expect(() => loadBatch(dir)).toThrow(/batch_id/);
  });
});

const stage = (over: any = {}) => ({ calls: 1, requestedModels: { 'gemini-4-argon': 1 }, servedModels: { 'gemini-4-argon': 1 }, servedModelMismatches: 0, maxTokens: 0, parseFailures: 0, timeouts: 0, inputTokens: 1_000_000, outputTokens: 100_000, thinkingTokens: 50_000, ...over });

describe('attempt classification', () => {
  it('a clean complete attempt is success; flags map to outcomes in a fixed priority', () => {
    expect(classifyCompleteAttempt({ stages: { subagent: { discovery: stage() }, basic: {}, shared: {} } })).toEqual({ outcome: 'success', flags: [] });
    const m = { stages: { subagent: { discovery: stage({ maxTokens: 2 }), deduplicate: stage({ timeouts: 1 }) }, basic: { remediation: stage({ parseFailures: 1 }) }, shared: {} } };
    const c = classifyCompleteAttempt(m);
    expect(c.outcome).toBe('max_tokens');
    expect(c.flags.sort()).toEqual(['max_tokens', 'parse_failure', 'stage_timeout']);
    const mm = { stages: { subagent: { discovery: stage({ servedModels: { 'gemini-3.6-flash': 1 } }) } } };
    expect(classifyCompleteAttempt(mm).outcome).toBe('served_model_mismatch');
  });

  it('a served-model pin makes an alias count as a match; without the pin it is a mismatch', () => {
    const s = stage({ requestedModels: { 'gemini-3.5-flash': 1 }, servedModels: { 'gemini-3.6-flash': 1 } });
    expect(stageServedMismatches(s)).toBe(1);
    expect(stageServedMismatches(s, { 'gemini-3.5-flash': ['gemini-3.6-flash'] })).toBe(0);
  });

  it('classifies failures: timeouts vs other errors', () => {
    expect(classifyFailure(new Error('The operation was aborted due to timeout'))).toBe('timeout');
    expect(classifyFailure(new Error('ETIMEDOUT'))).toBe('timeout');
    expect(classifyFailure(new Error('API returned 500'))).toBe('error');
  });

  it('stageFlagCounts sums across sources and stages', () => {
    const m = { stages: { subagent: { discovery: stage({ maxTokens: 1 }) }, basic: { discovery: stage({ maxTokens: 2 }) }, shared: { evaluate: stage({ parseFailures: 1 }) } } };
    expect(stageFlagCounts(m)).toEqual({ max_tokens: 3, parse_failure: 1, stage_timeout: 0, stage_error: 0, served_model_mismatch: 0 });
  });
});

describe('costOfMetrics', () => {
  it('prices each stage at its requested model and the date asked for (Argon doubles on 2026-12-01)', () => {
    const m = { stages: { subagent: { discovery: stage() }, basic: {}, shared: {} } };
    const now = costOfMetrics(m, new Date('2026-11-12T00:00:00Z'));
    const later = costOfMetrics(m, new Date('2026-12-01T00:00:00Z'));
    expect(now.usd).toBeCloseTo(1 * 2 + 0.1 * 10, 8);
    expect(later.usd).toBeCloseTo(1 * 4 + 0.1 * 20, 8);
    expect(now.thinkingTokens).toBe(50_000);
    expect(now.thinkingExtraUsd).toBeCloseTo(0.05 * 10, 8);
  });

  it('never prices an unknown model as $0: the stage is listed and excluded from usd', () => {
    const m = { stages: { subagent: { discovery: stage({ requestedModels: { 'gemini-9-nope': 1 } }), deduplicate: stage() }, basic: {}, shared: {} } };
    const c = costOfMetrics(m, new Date('2026-11-12T00:00:00Z'));
    expect(c.unknownStages).toEqual(['subagent.discovery']);
    expect(c.usd).toBeCloseTo(1 * 2 + 0.1 * 10, 8);
  });

  it('a stage with two requested models cannot be priced and is reported unknown', () => {
    const m = { stages: { subagent: { discovery: stage({ requestedModels: { 'gemini-4-argon': 1, 'gemini-3.8-flash': 1 } }) } } };
    expect(costOfMetrics(m, new Date()).unknownStages).toEqual(['subagent.discovery']);
  });
});

describe('CallBudget', () => {
  it('throws once the cap is reached and never goes past it', () => {
    const b = new CallBudget('t', 2);
    b.take(); b.take();
    expect(() => b.take()).toThrow(BudgetExceededError);
    expect(b.callsUsed).toBe(2);
  });
  it('requireCap has no default and rejects junk', () => {
    expect(() => requireCap('x', undefined)).toThrow(/required/);
    expect(() => requireCap('x', '')).toThrow(/required/);
    expect(() => requireCap('x', '-3')).toThrow(/integer/);
    expect(requireCap('x', '20')).toBe(20);
    expect(requireCap('x', '0')).toBe(0);
  });
});
