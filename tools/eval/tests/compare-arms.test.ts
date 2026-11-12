import { describe, it, expect } from '@jest/globals';
import { runWithRetries, buildRunRecord, planStartOrder, planCalls, hashSeed, RetryDeps } from '../compare-arms';
import { CallBudget, BudgetExceededError } from '../budget';
import { CombinedResult } from '../api-client';

const okResult = (stages: any = {}): CombinedResult => ({
  findings: [{ fileName: 'a.ts', lineNumber: 1, issueDescription: 'x', suggestion: '', severity: 'HIGH', source: 'basic' }],
  metrics: { inputTokens: 1, outputTokens: 1, calls: 3, durationMs: 10, stages },
});

function deps(script: Array<CombinedResult | Error>, budgetMax = 100): RetryDeps & { calls: number } {
  let i = 0;
  let t = 1_700_000_000_000;
  const d: any = {
    calls: 0,
    runReview: async () => { d.calls++; const next = script[i++]; if (next instanceof Error) throw next; return next; },
    now: () => (t += 1000),
    budget: new CallBudget('t', budgetMax),
    pins: {},
    inFlight: { n: 0 },
  };
  return d;
}
const args = { baseUrl: 'http://x', prUrl: 'https://github.com/o/r/pull/1', pat: 'p', maxAttempts: 3, timeoutMs: 1000 };

describe('runWithRetries', () => {
  it('a clean first attempt is accepted and never retried', async () => {
    const d = deps([okResult()]);
    const r = await runWithRetries(args, d);
    expect(d.calls).toBe(1);
    expect(r.acceptedAttempt).toBe(1);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ n: 1, complete: true, outcome: 'success', flags: [] });
  });

  it('failures are retried and EVERY attempt is saved with its outcome', async () => {
    const d = deps([new Error('The operation was aborted due to timeout'), new Error('API returned 500'), okResult()]);
    const r = await runWithRetries(args, d);
    expect(r.attempts.map(a => [a.n, a.complete, a.outcome])).toEqual([[1, false, 'timeout'], [2, false, 'error'], [3, true, 'success']]);
    expect(r.attempts[0].error).toMatch(/timeout/);
    expect(r.acceptedAttempt).toBe(3);
    const rec = buildRunRecord('b', 'ARM', args.prUrl, 1, r);
    expect(rec.first_attempt_complete).toBe(false);
    expect(rec.first_attempt_clean).toBe(false);
    expect(rec.retries).toBe(2);
    expect(rec.accepted_attempt).toBe(3);
    expect(rec.result?.findings).toHaveLength(1);
  });

  it('a COMPLETE attempt with stage flags is kept and flagged, not retried away', async () => {
    const stage = { calls: 1, requestedModels: { m: 1 }, servedModels: { m: 1 }, maxTokens: 1 };
    const d = deps([okResult({ subagent: { discovery: stage } }), okResult()]);
    const r = await runWithRetries(args, d);
    expect(d.calls).toBe(1);
    expect(r.attempts[0]).toMatchObject({ complete: true, outcome: 'max_tokens', flags: ['max_tokens'] });
    const rec = buildRunRecord('b', 'ARM', args.prUrl, 1, r);
    expect(rec.first_attempt_complete).toBe(true);
    expect(rec.first_attempt_clean).toBe(false); // complete, but not clean
  });

  it('gives up after maxAttempts with no result, and says so in the record', async () => {
    const d = deps([new Error('a'), new Error('b'), new Error('c'), okResult()]);
    const r = await runWithRetries(args, d);
    expect(d.calls).toBe(3);
    expect(r.result).toBeNull();
    const rec = buildRunRecord('b', 'ARM', args.prUrl, 2, r);
    expect(rec.result).toBeNull();
    expect(rec.accepted_attempt).toBeNull();
    expect(rec.attempts).toHaveLength(3);
    expect(rec.rep).toBe(2);
  });

  it('the call budget is a hard stop: it propagates instead of being recorded as a failed attempt', async () => {
    const d = deps([new Error('x'), new Error('y'), okResult()], 1);
    await expect(runWithRetries(args, d)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(d.calls).toBe(1);
  });

  it('records how many attempts were in flight at the start (load context) and releases the counter', async () => {
    const d = deps([okResult()]);
    d.inFlight.n = 4; // four other arms already running
    const r = await runWithRetries(args, d);
    expect(r.attempts[0].concurrent_arms).toBe(5);
    expect(d.inFlight.n).toBe(4);
  });

  it('the first attempt records the planned group size as load, not the start order', async () => {
    const d = deps([okResult()]);
    const r = await runWithRetries({ ...args, plannedConcurrency: 5 }, d);
    expect(r.attempts[0].concurrent_arms).toBe(5);
  });

  it('a served-model mismatch on a complete attempt is flagged', async () => {
    const stage = { calls: 1, requestedModels: { 'gemini-3.5-flash': 1 }, servedModels: { 'gemini-3.6-flash': 1 } };
    const r = await runWithRetries(args, deps([okResult({ subagent: { discovery: stage } })]));
    expect(r.attempts[0].outcome).toBe('served_model_mismatch');
  });
});

describe('planStartOrder / planCalls', () => {
  const arms = ['BASE', 'BASE2', 'ARGON', 'FLASH38', 'FLASH38_LOW'];
  it('is a permutation, deterministic for a seed, and varies across PRs and reps', () => {
    const a = planStartOrder(arms, 'pr-1', 1, 42);
    expect([...a].sort()).toEqual([...arms].sort());
    expect(planStartOrder(arms, 'pr-1', 1, 42)).toEqual(a);
    const orders = new Set<string>();
    for (let pr = 0; pr < 12; pr++) for (let rep = 1; rep <= 2; rep++) orders.add(planStartOrder(arms, `pr-${pr}`, rep, 42).join(','));
    expect(orders.size).toBeGreaterThan(5);
    expect(planStartOrder(arms, 'pr-1', 1, 43)).not.toBeUndefined();
    expect(hashSeed(1, 'a', 'b')).not.toBe(hashSeed(1, 'ab'));
  });
  it('plan arithmetic: PRs x reps x arms, and the worst case with retries', () => {
    expect(planCalls(23, 2, 5, 3)).toEqual({ prs: 23, reps: 2, arms: 5, reviews: 230, worstCaseAttempts: 690 });
    expect(planCalls(1, 1, 5, 3).reviews).toBe(5);
  });
});
