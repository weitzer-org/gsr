import { describe, it, expect } from '@jest/globals';
import { synthBatch, stageSummary } from './helpers/synthBatch';
import {
  computeRunMetrics, computeGroundTruth, computeReliability, evaluateCandidate, agreeJudging, decide, verdictFromMetrics,
  JudgeRecord, CandidateEvaluation, Gate,
} from '../analysis';
import { buildReport } from '../report';
import { classifyCompleteAttempt, stageFlagCounts } from '../batch';
import { loadSeededFixture } from '../groundtruth';

const evalFor = (data: any, cand: string, mode: 'basic' | 'subagent' = 'basic') => {
  const rows = computeRunMetrics(data);
  const gt = computeGroundTruth(data, undefined, undefined);
  const rel = computeReliability(data);
  return { rows, gt, rel, ev: evaluateCandidate(data, rows, gt, rel, cand, mode) };
};

describe('A/A control: BASE2 identical to BASE shows no difference anywhere', () => {
  const data = synthBatch();
  const { ev } = evalFor(data, 'BASE2');
  it('every measured comparison is a PASS with a zero-width interval', () => {
    for (const c of ev.comparisons.filter(c => c.cmp.n > 0)) {
      expect(c.cmp.verdict).toBe('PASS');
      expect(c.cmp.meanDiff).toBe(0);
    }
  });
  it('every measurable gate passes; ground-truth gates are UNMEASURED (no ground-truth PRs in the batch), not PASS', () => {
    const byName = Object.fromEntries(ev.gates.map(g => [g.name, g.status]));
    expect(byName['served-model mismatches = 0']).toBe('PASS');
    expect(byName['MAX_TOKENS + timeouts per stage <= BASE']).toBe('PASS');
    expect(byName['parse failures per stage <= BASE']).toBe('PASS');
    expect(byName['ground truth: no FAIL']).toBe('UNMEASURED');
    expect(byName['must_not_flag_high: false alarms <= BASE']).toBe('UNMEASURED');
  });
});

describe('a candidate that goes quiet on large PRs', () => {
  const data = synthBatch({ findingCount: (arm, pr) => (arm === 'CAND' && Number(pr.split('/').pop()) >= 7 ? 1 : 5) });
  it('fails large-PR recall and valid-findings, and is not adopted', () => {
    const { ev } = evalFor(data, 'CAND');
    expect(ev.largeRecallVerdict).toBe('FAIL');
    const d = decide(ev, { candidate: 'CAND', mode: 'basic', pairs: 10, agreed: { win: 5, loss: 0, tie: 5 }, disagreed: 0, invalid: 0, disagreements: [] });
    expect(d.decision).toBe('DO NOT ADOPT');
    expect(d.reasons.join(' ')).toMatch(/large-PR recall: FAIL/);
  });
  it('small PRs are unaffected, and recall is reported in both directions', () => {
    const rows = computeRunMetrics(data);
    const small = rows.filter(r => r.arm === 'CAND' && r.mode === 'basic' && r.size === 'small');
    expect(small.every(r => r.recallOfBase === 1 && r.baseRecallOfThis === 1)).toBe(true);
    const large = rows.filter(r => r.arm === 'CAND' && r.mode === 'basic' && r.size === 'large');
    expect(large.every(r => r.recallOfBase === 0.2 && r.baseRecallOfThis === 1)).toBe(true);
  });
});

describe('gates', () => {
  it('a served-model mismatch fails the gate', () => {
    const data = synthBatch({ servedModel: arm => (arm === 'CAND' ? 'gemini-3.6-flash' : undefined as any) });
    const { ev } = evalFor(data, 'CAND');
    expect(ev.gates.find(g => g.name === 'served-model mismatches = 0')!.status).toBe('FAIL');
  });

  it('MAX_TOKENS / timeouts per stage worse than BASE fails; equal to BASE passes', () => {
    const worse = synthBatch({ stageFor: (arm, src, st) => (arm === 'CAND' && src === 'subagent' && st === 'discovery' ? { maxTokens: 1 } : {}) });
    expect(evalFor(worse, 'CAND', 'subagent').ev.gates.find(g => g.name.startsWith('MAX_TOKENS'))!.status).toBe('FAIL');
    const same = synthBatch({ stageFor: (arm, src, st) => (src === 'subagent' && st === 'discovery' && (arm === 'CAND' || arm === 'BASE') ? { maxTokens: 1 } : {}) });
    expect(evalFor(same, 'CAND', 'subagent').ev.gates.find(g => g.name.startsWith('MAX_TOKENS'))!.status).toBe('PASS');
  });

  it('parse failures worse than BASE fail', () => {
    const data = synthBatch({ stageFor: (arm, src, st) => (arm === 'CAND' && src === 'basic' && st === 'discovery' ? { parseFailures: 1 } : {}) });
    expect(evalFor(data, 'CAND', 'basic').ev.gates.find(g => g.name.startsWith('parse failures'))!.status).toBe('FAIL');
  });

  it('the first-attempt gate tolerates the BASE-vs-BASE2 gap and fails below it', () => {
    const data = synthBatch();
    // BASE: 24/24 complete. BASE2: drop 4 of 24 -> gap 16.7 pts. CAND: 20/24 (83%) = floor -> PASS; 19/24 -> FAIL.
    const fail = (arm: string, n: number) => { let k = 0; for (const r of data.runs.filter(r => r.arm === arm)) if (k++ < n) r.first_attempt_complete = false; };
    fail('BASE2', 4);
    fail('CAND', 4);
    expect(evalFor(data, 'CAND').ev.gates.find(g => g.name.startsWith('first-attempt'))!.status).toBe('PASS');
    fail('CAND', 5);
    expect(evalFor(data, 'CAND').ev.gates.find(g => g.name.startsWith('first-attempt'))!.status).toBe('FAIL');
  });
});

describe('ground truth with seeded PRs in the batch', () => {
  const fx = loadSeededFixture();
  const seededPrs = fx.entries.map(e => ({ url: e.prUrl, size: 'small' as const }));
  const mk = (catchFor: (arm: string) => boolean) => {
    const data = synthBatch({
      prs: seededPrs,
      extraFindings: (arm, pr) => {
        const e = fx.entries.find(x => x.prUrl === pr)!;
        return catchFor(arm) ? [{ fileName: e.locations[0].file, lineNumber: e.locations[0].lineStart, issueDescription: 'bug', suggestion: '', severity: 'HIGH', source: 'basic' }] : [];
      },
    });
    return data;
  };

  it('scores a catch and a miss per arm; a candidate that misses everything BASE catches FAILs the ground-truth gate', () => {
    const data = mk(arm => arm !== 'CAND');
    const gt = computeGroundTruth(data, fx, undefined);
    expect(gt.filter(g => g.arm === 'BASE' && g.mode === 'basic' && g.kind === 'seeded').every(g => g.caught)).toBe(true);
    expect(gt.filter(g => g.arm === 'CAND' && g.mode === 'basic' && g.kind === 'seeded').every(g => !g.caught)).toBe(true);
    const rows = computeRunMetrics(data);
    const ev = evaluateCandidate(data, rows, gt, computeReliability(data), 'CAND', 'basic');
    expect(ev.gates.find(g => g.name === 'ground truth: no FAIL')!.status).toBe('FAIL');
    expect(ev.groundTruthVerdict).toBe('FAIL');
  });

  it('a candidate equal to BASE passes ground truth; the A/A control passes', () => {
    const data = mk(() => true);
    const gt = computeGroundTruth(data, fx, undefined);
    const ev = evaluateCandidate(data, computeRunMetrics(data), gt, computeReliability(data), 'CAND', 'basic');
    expect(ev.gates.find(g => g.name === 'ground truth: no FAIL')!.status).toBe('PASS');
  });
});

describe('judge agreement and the decision rule', () => {
  const rec = (pr: string, idx: 1 | 2, verdict: any, over: Partial<JudgeRecord> = {}): JudgeRecord => ({
    schema: 1, batch_id: 'b', pr, rep: 1, candidate: 'CAND', baseline: 'BASE', mode: 'basic', judge_index: idx,
    judge_requested: idx === 1 ? 'gemini-2.5-pro' : 'gemini-3.8-flash', swapped: false, plausible: true, verdict, ...over,
  });

  it('counts only verdicts both judges agree on, and reports the disagreements', () => {
    const records = [
      rec('p1', 1, 'win'), rec('p1', 2, 'win'),
      rec('p2', 1, 'win'), rec('p2', 2, 'loss'),
      rec('p3', 1, 'loss'), rec('p3', 2, 'loss'),
      rec('p4', 1, 'tie'), rec('p4', 2, 'tie'),
    ];
    const a = agreeJudging(records, 'CAND', 'basic');
    expect(a.pairs).toBe(4);
    expect(a.agreed).toEqual({ win: 1, loss: 1, tie: 1 });
    expect(a.disagreed).toBe(1);
    expect(a.disagreements).toEqual([{ pr: 'p2', rep: 1, judge1: 'win', judge2: 'loss' }]);
  });

  it('a pair is invalid (not agreed, not disagreed) when a record is implausible, served by another model, or missing', () => {
    const records = [
      rec('p1', 1, 'win', { plausible: false }), rec('p1', 2, 'win'),
      rec('p2', 1, 'win', { judge_served: 'gemini-3.1-pro-preview' }), rec('p2', 2, 'win'),
      rec('p3', 1, 'win'), // judge 2 missing
      rec('p4', 1, 'win', { judge_served: 'gemini-2.5-pro' }), rec('p4', 2, 'win', { judge_served: 'models/gemini-3.8-flash' }),
    ];
    const a = agreeJudging(records, 'CAND', 'basic');
    expect(a.invalid).toBe(3);
    expect(a.agreed.win).toBe(1);
  });

  it('verdict: actionability first, then fewer false positives, else tie', () => {
    expect(verdictFromMetrics({ actionability: 7, falsePositives: 5 }, { actionability: 6, falsePositives: 0 })).toBe('win');
    expect(verdictFromMetrics({ actionability: 5, falsePositives: 0 }, { actionability: 6, falsePositives: 9 })).toBe('loss');
    expect(verdictFromMetrics({ actionability: 6, falsePositives: 1 }, { actionability: 6, falsePositives: 3 })).toBe('win');
    expect(verdictFromMetrics({ actionability: 6, falsePositives: 3 }, { actionability: 6, falsePositives: 1 })).toBe('loss');
    expect(verdictFromMetrics({ actionability: 6, falsePositives: 1 }, { actionability: 6, falsePositives: 1 })).toBe('tie');
  });

  const gate = (status: Gate['status']): Gate => ({ name: 'g', status, detail: '' });
  const ev = (over: Partial<CandidateEvaluation>): CandidateEvaluation => ({ candidate: 'CAND', mode: 'basic', gates: [gate('PASS')], comparisons: [], groundTruthVerdict: 'PASS', largeRecallVerdict: 'PASS', ...over });
  const judged = (win: number, loss: number) => ({ candidate: 'CAND', mode: 'basic' as const, pairs: win + loss, agreed: { win, loss, tie: 0 }, disagreed: 0, invalid: 0, disagreements: [] });

  it('ADOPT only when every gate passes, ground truth and large-PR recall are clean PASSes, and wins >= losses', () => {
    expect(decide(ev({}), judged(3, 3)).decision).toBe('ADOPT');
    expect(decide(ev({}), judged(2, 3)).decision).toBe('DO NOT ADOPT');
  });
  it('WARN is not a pass, on ground truth or on large-PR recall', () => {
    expect(decide(ev({ groundTruthVerdict: 'WARN' }), judged(5, 0)).decision).toBe('DO NOT ADOPT');
    expect(decide(ev({ largeRecallVerdict: 'WARN' }), judged(5, 0)).decision).toBe('DO NOT ADOPT');
  });
  it('an unmeasured gate or missing judging is UNDETERMINED, never an implicit pass; a FAIL still wins over unmeasured', () => {
    expect(decide(ev({ gates: [gate('PASS'), gate('UNMEASURED')] }), judged(5, 0)).decision).toBe('UNDETERMINED');
    expect(decide(ev({}), undefined).decision).toBe('UNDETERMINED');
    expect(decide(ev({ gates: [gate('FAIL'), gate('UNMEASURED')] }), judged(5, 0)).decision).toBe('DO NOT ADOPT');
  });
});

describe('buildReport', () => {
  const data = synthBatch({ findingCount: (arm, pr) => (arm === 'CAND' && Number(pr.split('/').pop()) >= 7 ? 1 : 5) });
  const { markdown, json } = buildReport({ data, judge: [], seeded: loadSeededFixture() });

  it('has every required section and the arm routing table', () => {
    for (const h of ['## 1. What ran', '## 2. Integrity', '## 3. Findings', '## 4. Recall', '## 5. Ground truth', '## 6. LLM-judge', '## 7. Latency', '## 8. Statistics', '## 9. Gates and decision']) {
      expect(markdown).toContain(h);
    }
    expect(markdown).toContain('| BASE | baseline |');
  });
  it('reports ground truth as UNMEASURED rather than zero when no ground-truth PR is in the batch', () => {
    expect(markdown).toMatch(/\*\*UNMEASURED\.\*\*/);
  });
  it('reports judging as absent rather than inventing verdicts, and the decision is not ADOPT', () => {
    expect(markdown).toContain('No judge records in this batch');
    expect(json.decisions.every((d: any) => d.decision !== 'ADOPT')).toBe(true);
  });
  it('shows cost as unknown, not $0, when a stage\'s model has no price row', () => {
    const d2 = synthBatch();
    for (const r of d2.runs.filter(r => r.arm === 'CAND')) r.result!.metrics.stages.subagent.discovery = stageSummary('gemini-9-unpriced');
    const md2 = buildReport({ data: d2, judge: [] }).markdown;
    expect(md2).toMatch(/unknown \(\d+ stage\(s\) excluded\)/);
  });
  it('prices Argon at the scheduled rate on each date', () => {
    expect(markdown).toContain('cost/review from 2026-12-01');
    const row = markdown.split('\n').find(l => l.startsWith('| CAND |') && l.includes('$'))!;
    expect(row).toBeDefined();
  });
  it('keeps latency out of cross-mode pooling: per-mode latency rows are separate', () => {
    expect(markdown).toMatch(/\| BASE \| basic \|/);
    expect(markdown).toMatch(/\| BASE \| swarm \|/);
  });
});

describe('regressions found by the independent verifier on the smoke batch', () => {
  it('a stage API error (e.g. the deduplicator or evaluate call dying) is a flag, an outcome and a gate — not a clean run', () => {
    const stage = (over: any) => ({ calls: 1, successes: 0, failures: 1, requestedModels: { m: 1 }, servedModels: {}, errorKinds: { api_error: 1 }, ...over });
    const m = { stages: { subagent: { deduplicate: stage({}) }, basic: {}, shared: { evaluate: stage({}) } } };
    expect(classifyCompleteAttempt(m)).toEqual({ outcome: 'stage_error', flags: ['stage_error'] });
    expect(stageFlagCounts(m).stage_error).toBe(2);
    // a timeout is its own flag and is not double counted as an API error
    const t = { stages: { subagent: { deduplicate: stage({ errorKinds: { timeout: 1 } }) } } };
    expect(stageFlagCounts(t)).toMatchObject({ stage_error: 0, stage_timeout: 0 });
  });

  it('the gate fails a candidate whose stages error more than BASE, and the report shows the column', () => {
    const data = synthBatch({ stageFor: (arm, src, st) => (arm === 'CAND' && src === 'subagent' && st === 'deduplicate' ? { failures: 1, successes: 1 } : {}) });
    const { ev } = evalFor(data, 'CAND', 'subagent');
    expect(ev.gates.find(g => g.name.startsWith('stage API errors'))!.status).toBe('FAIL');
    expect(buildReport({ data, judge: [] }).markdown).toContain('API errors (non-timeout)');
  });

  it('recall is judged against the A/A control\'s recall of BASE, not against BASE\'s trivial 100%', () => {
    // BASE2 recovers only 60% of BASE (noise). A candidate at 60% is therefore no worse than the control.
    const data = synthBatch({ findingCount: (arm, pr, rep, mode) => (arm === 'BASE2' || arm === 'CAND' ? 3 : 5) });
    const rows = computeRunMetrics(data);
    const gt = computeGroundTruth(data, undefined, undefined);
    const ev = evaluateCandidate(data, rows, gt, computeReliability(data), 'CAND', 'basic');
    const r = ev.comparisons.find(c => c.label === 'recall of BASE findings' && c.size === 'large')!;
    expect(r.cmp.meanBase).toBeCloseTo(0.6, 8);
    expect(r.cmp.verdict).toBe('PASS');
    // and the control itself does not FAIL against itself
    const evc = evaluateCandidate(data, rows, gt, computeReliability(data), 'BASE2', 'basic');
    expect(evc.largeRecallVerdict).toBe('PASS');
  });

  it('with no control arm the recall comparison is UNMEASURED, never degenerate', () => {
    const data = synthBatch({ arms: [{ name: 'BASE', role: 'baseline' }, { name: 'CAND', role: 'candidate' }] });
    const rows = computeRunMetrics(data);
    const ev = evaluateCandidate(data, rows, computeGroundTruth(data, undefined, undefined), computeReliability(data), 'CAND', 'basic');
    expect(ev.largeRecallVerdict).toBe('UNMEASURED');
  });
});
