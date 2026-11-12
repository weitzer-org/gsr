import { describe, it, expect } from '@jest/globals';
import { synthBatch } from './helpers/synthBatch';
import { planJudging, pickSecondJudge, unswapMetrics, runJudgeTask, judgeFileName } from '../judge-batch';
import { agreeJudging } from '../analysis';

const arms = [{ name: 'BASE', role: 'baseline' as const }, { name: 'BASE2', role: 'control' as const }, { name: 'CAND', role: 'candidate' as const }, { name: 'C2', role: 'candidate' as const }];

describe('pickSecondJudge', () => {
  it('uses the preferred judge unless it is in the pair, then the first alternate that is not', () => {
    expect(pickSecondJudge(new Set(['gemini-4-argon', 'gemini-3.1-pro-preview']), 'gemini-3.8-flash', ['gemini-4-argon'])).toBe('gemini-3.8-flash');
    expect(pickSecondJudge(new Set(['gemini-3.8-flash', 'gemini-3.1-pro-preview']), 'gemini-3.8-flash', ['gemini-4-argon'])).toBe('gemini-4-argon');
    expect(() => pickSecondJudge(new Set(['gemini-3.8-flash']), 'gemini-3.8-flash', ['gemini-3.8-flash'])).toThrow(/No second judge/);
  });
});

describe('planJudging', () => {
  const data = synthBatch({ arms, reps: 2 });
  const tasks = planJudging(data, { judge1: 'gemini-2.5-pro', judge2: 'gemini-3.8-flash', alternates: ['gemini-4-argon'] });

  it('plans candidates x PRs x reps x modes x 2 judges (the control included, the baseline never judged against itself)', () => {
    expect(tasks).toHaveLength(3 * 12 * 2 * 2 * 2);
    expect(tasks.some(t => t.candidate === 'BASE')).toBe(false);
    expect(tasks.some(t => t.candidate === 'BASE2')).toBe(true);
  });

  it('never uses as judge 2 a model that is in the pair being judged', () => {
    const argon = tasks.filter(t => t.candidate === 'CAND' && t.judgeIndex === 2);
    expect(new Set(argon.map(t => t.judgeModel))).toEqual(new Set(['gemini-3.8-flash']));
    const flash = tasks.filter(t => t.candidate === 'C2' && t.judgeIndex === 2);
    expect(new Set(flash.map(t => t.judgeModel))).toEqual(new Set(['gemini-4-argon']));
    expect(new Set(tasks.filter(t => t.judgeIndex === 1).map(t => t.judgeModel))).toEqual(new Set(['gemini-2.5-pro']));
  });

  it('skips pairs where either side has no accepted result', () => {
    const d = synthBatch({ arms, reps: 1 });
    d.runs.find(r => r.arm === 'CAND' && r.pr.endsWith('/1'))!.result = null;
    const t = planJudging(d, { judge1: 'a', judge2: 'b', alternates: [] });
    expect(t.some(x => x.candidate === 'CAND' && x.pr.endsWith('/1'))).toBe(false);
    expect(t.some(x => x.candidate === 'C2' && x.pr.endsWith('/1'))).toBe(true);
  });

  it('file names are unique per task', () => {
    expect(new Set(tasks.map(t => t.file)).size).toBe(tasks.length);
    expect(judgeFileName('s', 1, 'C', 'B', 'basic', 2)).toBe('s__rep1__C-vs-B__basic__j2.json');
  });
});

describe('runJudgeTask: blinding, un-swapping, validity', () => {
  const data = synthBatch({ arms, reps: 1 });
  const task = planJudging(data, { judge1: 'gemini-2.5-pro', judge2: 'gemini-3.8-flash', alternates: ['gemini-4-argon'] }).find(t => t.candidate === 'CAND' && t.mode === 'basic' && t.judgeIndex === 1)!;
  const scores = (a: number, b: number, plausible = true) => async (...args: any[]) => ({
    report: 'r', plausible, implausibleReason: plausible ? undefined : 'bad', judgeModel: args[7].model, judgeServedModel: args[7].model,
    metrics: { targetA: { actionability: a, falsePositives: 0, uniqueFindings: 0 }, targetB: { actionability: b, falsePositives: 0, uniqueFindings: 0 }, gca: {}, codeRabbit: {}, overlapMatrix: {} },
  } as any);

  it('uses blind labels, passes the requested model, and un-swaps so the verdict is about the candidate', async () => {
    let seen: any[] = [];
    const judge = async (...args: any[]) => { seen = args; return scores(8, 2)(...args); };
    const rec = await runJudgeTask(data, task, 1, judge as any);
    expect(seen[5]).toBe('Reviewer 1');
    expect(seen[6]).toBe('Reviewer 2');
    expect(seen[7]).toEqual({ model: 'gemini-2.5-pro' });
    // slot 1 scored 8, slot 2 scored 2: if swapped, slot 1 held BASE so the candidate got 2.
    expect(rec.candidate_metrics!.actionability).toBe(rec.swapped ? 2 : 8);
    expect(rec.baseline_metrics!.actionability).toBe(rec.swapped ? 8 : 2);
    expect(rec.verdict).toBe(rec.swapped ? 'loss' : 'win');
    expect(rec.judge_served).toBe('gemini-2.5-pro');
  });

  it('both judges see the same order for a pair (the swap is not seeded by the judge)', async () => {
    const t2 = { ...task, judgeIndex: 2 as const, judgeModel: 'gemini-3.8-flash' };
    const a = await runJudgeTask(data, task, 7, scores(5, 5) as any);
    const b = await runJudgeTask(data, t2, 7, scores(5, 5) as any);
    expect(a.swapped).toBe(b.swapped);
  });

  it('is deterministic for a seed and varies across pairs', async () => {
    const swaps = new Set<boolean>();
    for (const t of planJudging(data, { judge1: 'a', judge2: 'b', alternates: [] }).filter(t => t.judgeIndex === 1 && t.mode === 'basic')) {
      swaps.add((await runJudgeTask(data, t, 3, scores(1, 1) as any)).swapped);
    }
    expect(swaps.size).toBe(2);
  });

  it('an implausible judge result is an invalid record, with the reason kept', async () => {
    const rec = await runJudgeTask(data, task, 1, scores(8, 2, false) as any);
    expect(rec.verdict).toBe('invalid');
    expect(rec.plausible).toBe(false);
    expect(rec.reason).toBe('bad');
  });

  it('a failed judge call is an invalid record, not a thrown error', async () => {
    const rec = await runJudgeTask(data, task, 1, (async () => { throw new Error('503 overloaded'); }) as any);
    expect(rec.verdict).toBe('invalid');
    expect(rec.reason).toMatch(/503/);
  });

  it('a judge served by a different model than requested is dropped by the agreement step', async () => {
    const j1 = await runJudgeTask(data, task, 1, (async (...a: any[]) => ({ ...(await scores(8, 2)(...a)), judgeServedModel: 'gemini-3.1-pro-preview' })) as any);
    const j2 = await runJudgeTask(data, { ...task, judgeIndex: 2, judgeModel: 'gemini-3.8-flash' }, 1, scores(8, 2) as any);
    const a = agreeJudging([j1, j2], 'CAND', 'basic');
    expect(a.invalid).toBe(1);
    expect(a.agreed.win + a.agreed.loss + a.agreed.tie).toBe(0);
  });

  it('unswapMetrics', () => {
    expect(unswapMetrics('s1', 's2', false)).toEqual({ candidate: 's1', baseline: 's2' });
    expect(unswapMetrics('s1', 's2', true)).toEqual({ candidate: 's2', baseline: 's1' });
  });
});
