// Pure analysis over a loaded batch: per-run metrics, per-PR series, gates and decision rule.
// No I/O and no model calls, so every number in the report can be recomputed from the batch
// directory alone (docs/eval/model-upgrade-test-plan.md defines the gates this implements).
import { BatchData, RunRecord, ManifestPr, ServedPins, stageServedMismatches, costOfMetrics } from './batch';
import { ReviewFinding } from './api-client';
import { validateFindingsAgainstDiff, computeRecall } from './validation';
import { scoreSeeded, loadSeededFixture, SeededFixture } from './groundtruth';
import { scoreFixtureEntries, Fixture } from './fixture-regression';
import { compareMeasure, MeasureComparison, perPrMeans, percentile, Verdict, MeasureKind } from './stats';

export type Mode = 'basic' | 'subagent';          // 'subagent' is the swarm ("deep-review")
export const MODES: readonly Mode[] = ['basic', 'subagent'];
export type SizeFilter = 'all' | 'small' | 'large';
export const SIZE_FILTERS: readonly SizeFilter[] = ['all', 'small', 'large'];

export interface StageAgg {
  calls: number; maxTokens: number; timeouts: number; parseFailures: number; servedMismatches: number; thinkingTokens: number;
}

export interface RunMetrics {
  arm: string;
  pr: string;
  slug: string;
  rep: number;
  size: 'small' | 'large';
  mode: Mode;
  findings: number;          // in-mode findings returned by the API
  valid: number;             // survive validateFindingsAgainstDiff
  hallucinated: number;
  high: number;              // valid HIGH/CRITICAL
  recallOfBase?: number;     // share of BASE's valid findings (same PR, same rep) this arm also found
  baseRecallOfThis?: number; // share of THIS arm's valid findings that BASE also found
  latencyMs?: number;        // that orchestrator's own wall-clock (metrics.<mode>Metrics.durationMs)
  stages: Record<string, StageAgg>;   // this mode's stages + `shared.*` (the evaluate call)
  thinkingTokens: number;
  costNow: number; costUnknownStages: string[]; thinkingExtraNow: number;
}

function inModeStages(metrics: any, mode: Mode): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, s] of Object.entries<any>(metrics?.stages?.[mode] ?? {})) out[name] = s;
  for (const [name, s] of Object.entries<any>(metrics?.stages?.shared ?? {})) out[`shared.${name}`] = s;
  return out;
}

function aggStages(metrics: any, mode: Mode, pins: ServedPins): Record<string, StageAgg> {
  const out: Record<string, StageAgg> = {};
  for (const [name, s] of Object.entries(inModeStages(metrics, mode))) {
    out[name] = {
      calls: s.calls ?? 0, maxTokens: s.maxTokens ?? 0, timeouts: s.timeouts ?? 0, parseFailures: s.parseFailures ?? 0,
      servedMismatches: stageServedMismatches(s, pins), thinkingTokens: s.thinkingTokens ?? 0,
    };
  }
  return out;
}

export function findingsOfMode(findings: ReviewFinding[], mode: Mode): ReviewFinding[] {
  return findings.filter(f => (f.source ?? 'basic') === mode);
}

export interface AnalysisOptions {
  pins?: ServedPins;
  priceAt?: Date;          // date for "today's rates"
}

export function sizeOf(data: BatchData, prUrl: string): 'small' | 'large' {
  return data.manifest.prs.find(p => p.url === prUrl)?.size_class ?? 'small';
}

export function acceptedRuns(data: BatchData): RunRecord[] {
  return data.runs.filter(r => r.result);
}

function runKey(pr: string, rep: number, arm: string): string {
  return `${pr}#${rep}#${arm}`;
}

export function computeRunMetrics(data: BatchData, opts: AnalysisOptions = {}): RunMetrics[] {
  const pins = opts.pins ?? {};
  const priceAt = opts.priceAt ?? new Date();
  const byKey = new Map<string, RunRecord>();
  for (const r of data.runs) byKey.set(runKey(r.pr, r.rep, r.arm), r);
  const base = data.manifest.baseline_arm;
  const rows: RunMetrics[] = [];

  for (const run of acceptedRuns(data)) {
    const diff = data.diffs.get(run.pr_slug);
    const size = sizeOf(data, run.pr);
    const cost = costOfMetrics(run.result!.metrics, priceAt);
    for (const mode of MODES) {
      const own = findingsOfMode(run.result!.findings, mode);
      const v = diff ? validateFindingsAgainstDiff(own, diff) : { validFindings: own, hallucinatedFindings: [] as ReviewFinding[] };
      const metrics = run.result!.metrics;
      const stages = aggStages(metrics, mode, pins);
      const modeMetrics = mode === 'basic' ? metrics?.basicMetrics : metrics?.subagentMetrics;
      const row: RunMetrics = {
        arm: run.arm, pr: run.pr, slug: run.pr_slug, rep: run.rep, size, mode,
        findings: own.length,
        valid: v.validFindings.length,
        hallucinated: v.hallucinatedFindings.length,
        high: v.validFindings.filter(f => /^(HIGH|CRITICAL)$/i.test(f.severity || '')).length,
        latencyMs: typeof modeMetrics?.durationMs === 'number' ? modeMetrics.durationMs : undefined,
        stages,
        thinkingTokens: Object.values(stages).reduce((s, x) => s + x.thinkingTokens, 0),
        costNow: cost.usd, costUnknownStages: cost.unknownStages, thinkingExtraNow: cost.thinkingExtraUsd,
      };
      const baseRun = byKey.get(runKey(run.pr, run.rep, base));
      if (baseRun?.result && diff) {
        const baseOwn = findingsOfMode(baseRun.result.findings, mode);
        const baseValid = validateFindingsAgainstDiff(baseOwn, diff).validFindings;
        row.recallOfBase = computeRecall(v.validFindings, baseValid).recallFraction;
        row.baseRecallOfThis = computeRecall(baseValid, v.validFindings).recallFraction;
      }
      rows.push(row);
    }
  }
  return rows;
}

// ---- ground truth ---------------------------------------------------------------------------

export interface GroundTruthRow {
  arm: string; pr: string; rep: number; mode: Mode; kind: 'seeded' | 'must_catch' | 'must_not_flag_high' | 'must_resolve_cross_file';
  caught: boolean;          // seeded: the bug was caught; fixture kinds: the entry passed
  highUnmatched?: number;   // seeded only
}

export function computeGroundTruth(
  data: BatchData,
  seeded: SeededFixture | undefined,
  jt: Fixture | undefined
): GroundTruthRow[] {
  const rows: GroundTruthRow[] = [];
  const arms = data.manifest.arms.map(a => a.name);
  const reps = Array.from({ length: data.manifest.reps }, (_, i) => i + 1);
  for (const arm of arms) {
    for (const rep of reps) {
      const runs = data.runs.filter(r => r.arm === arm && r.rep === rep);
      const findingsByPr: Record<string, ReviewFinding[] | undefined> = {};
      for (const r of runs) findingsByPr[r.pr] = r.result?.findings;
      for (const mode of MODES) {
        if (seeded) {
          for (const s of scoreSeeded(seeded, findingsByPr, mode)) {
            rows.push({ arm, pr: s.prUrl, rep, mode, kind: 'seeded', caught: s.caught, highUnmatched: s.highUnmatched });
          }
        }
        if (jt) {
          const present = new Set(runs.map(r => r.pr));
          // Only score fixture entries whose PR was actually part of this batch; a PR that was not
          // in the batch is not a failure of the arm.
          const subset: Fixture = {
            ...jt,
            entries: {
              must_catch: jt.entries.must_catch.filter(e => present.has(e.prUrl)),
              must_not_flag_high: jt.entries.must_not_flag_high.filter(e => present.has(e.prUrl)),
              must_resolve_cross_file: jt.entries.must_resolve_cross_file.filter(e => present.has(e.prUrl)),
            },
          };
          const errors: Record<string, string | undefined> = {};
          for (const r of runs) if (!r.result) errors[r.pr] = 'no accepted result';
          for (const res of scoreFixtureEntries(subset, findingsByPr, errors, mode)) {
            rows.push({ arm, pr: res.prUrl, rep, mode, kind: res.category, caught: res.pass });
          }
        }
      }
    }
  }
  return rows;
}

// ---- reliability (one HTTP review, shared by both modes) --------------------------------------

export interface Reliability {
  arm: string;
  runs: number;
  firstAttemptComplete: number;
  firstAttemptClean: number;
  totalRetries: number;
  neverCompleted: number;      // runs with no accepted result after every attempt
  outcomes: Record<string, number>;   // every attempt's outcome, retries included
}

export function computeReliability(data: BatchData): Reliability[] {
  return data.manifest.arms.map(a => {
    const runs = data.runs.filter(r => r.arm === a.name);
    const outcomes: Record<string, number> = {};
    for (const r of runs) for (const at of r.attempts) outcomes[at.outcome] = (outcomes[at.outcome] ?? 0) + 1;
    return {
      arm: a.name,
      runs: runs.length,
      firstAttemptComplete: runs.filter(r => r.first_attempt_complete).length,
      firstAttemptClean: runs.filter(r => r.first_attempt_clean).length,
      totalRetries: runs.reduce((s, r) => s + r.retries, 0),
      neverCompleted: runs.filter(r => !r.result).length,
      outcomes,
    };
  });
}

// ---- series and comparisons --------------------------------------------------------------------

export type Measure =
  | 'valid' | 'findings' | 'high' | 'recallOfBase' | 'seededCatch' | 'mustCatch';

const MEASURE_KIND: Record<Measure, MeasureKind> = {
  valid: 'count', findings: 'count', high: 'count', recallOfBase: 'share', seededCatch: 'share', mustCatch: 'share',
};

export function prsFor(data: BatchData, size: SizeFilter): ManifestPr[] {
  return data.manifest.prs.filter(p => size === 'all' || p.size_class === size);
}

function runMeasureRows(measure: Measure, arm: string, mode: Mode, runRows: RunMetrics[], gt: GroundTruthRow[]): Array<{ pr: string; rep: number; value: number }> {
  if (measure === 'seededCatch') return gt.filter(g => g.arm === arm && g.mode === mode && g.kind === 'seeded').map(g => ({ pr: g.pr, rep: g.rep, value: g.caught ? 1 : 0 }));
  if (measure === 'mustCatch') return gt.filter(g => g.arm === arm && g.mode === mode && g.kind === 'must_catch').map(g => ({ pr: g.pr, rep: g.rep, value: g.caught ? 1 : 0 }));
  return runRows.filter(r => r.arm === arm && r.mode === mode).map(r => ({
    pr: r.pr, rep: r.rep, value: (r as any)[measure] as number,
  })).filter(x => x.value !== undefined);
}

// Paired per-PR comparison of `cand` against `base` on one measure, restricted to a size class.
// A PR contributes only if BOTH arms have a value for it (reps averaged within the PR first).
export function compareArms(
  data: BatchData, runRows: RunMetrics[], gt: GroundTruthRow[],
  cand: string, base: string, mode: Mode, measure: Measure, size: SizeFilter, seed?: number
): MeasureComparison {
  const prs = prsFor(data, size).map(p => p.url);
  const c = perPrMeans(runMeasureRows(measure, cand, mode, runRows, gt).map(x => ({ pr: x.pr, value: x.value })), prs);
  const b = perPrMeans(runMeasureRows(measure, base, mode, runRows, gt).map(x => ({ pr: x.pr, value: x.value })), prs);
  // recallOfBase for the baseline itself is trivially 1; comparing it with itself is a no-op.
  return compareMeasure(c, b, MEASURE_KIND[measure], { seed });
}

// ---- gates ----------------------------------------------------------------------------------------

export type GateStatus = 'PASS' | 'FAIL' | 'UNMEASURED';
export interface Gate { name: string; status: GateStatus; detail: string }

function sumStages(rows: RunMetrics[], arm: string, mode: Mode, pick: (s: StageAgg) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows.filter(x => x.arm === arm && x.mode === mode)) {
    for (const [name, s] of Object.entries(r.stages)) out[name] = (out[name] ?? 0) + pick(s);
  }
  return out;
}

function stageGate(name: string, rows: RunMetrics[], cand: string, base: string, mode: Mode, pick: (s: StageAgg) => number, what: string): Gate {
  const c = sumStages(rows, cand, mode, pick);
  const b = sumStages(rows, base, mode, pick);
  const stages = Array.from(new Set([...Object.keys(c), ...Object.keys(b)]));
  const bad = stages.filter(s => (c[s] ?? 0) > (b[s] ?? 0));
  const fmt = (m: Record<string, number>) => stages.map(s => `${s}=${m[s] ?? 0}`).join(', ') || 'none';
  return {
    name, status: bad.length ? 'FAIL' : 'PASS',
    detail: `${what}: ${cand} [${fmt(c)}] vs ${base} [${fmt(b)}]${bad.length ? `; worse in ${bad.join(', ')}` : ''}`,
  };
}

export interface CandidateEvaluation {
  candidate: string;
  mode: Mode;
  gates: Gate[];
  comparisons: Array<{ label: string; size: SizeFilter; cmp: MeasureComparison }>;
  groundTruthVerdict: Verdict;
  largeRecallVerdict: Verdict;
}

export function evaluateCandidate(
  data: BatchData, runRows: RunMetrics[], gt: GroundTruthRow[], rel: Reliability[],
  candidate: string, mode: Mode, seed?: number
): CandidateEvaluation {
  const base = data.manifest.baseline_arm;
  const control = data.manifest.control_arm;
  const gates: Gate[] = [];

  // 1. served-model mismatches = 0
  const mism = sumStages(runRows, candidate, mode, s => s.servedMismatches);
  const mismTotal = Object.values(mism).reduce((a, b) => a + b, 0);
  const candRuns = runRows.filter(r => r.arm === candidate && r.mode === mode).length;
  gates.push({
    name: 'served-model mismatches = 0',
    status: candRuns === 0 ? 'UNMEASURED' : mismTotal === 0 ? 'PASS' : 'FAIL',
    detail: candRuns === 0 ? 'no accepted runs' : `${mismTotal} mismatched call(s) over ${candRuns} run(s) [${Object.entries(mism).map(([k, v]) => `${k}=${v}`).join(', ')}]`,
  });

  // 2. first-attempt success >= BASE minus the BASE-vs-BASE2 gap
  const r = (arm: string) => rel.find(x => x.arm === arm);
  const rate = (arm: string) => { const x = r(arm); return x && x.runs ? x.firstAttemptComplete / x.runs : NaN; };
  const cRate = rate(candidate), bRate = rate(base), b2Rate = control ? rate(control) : NaN;
  if ([cRate, bRate].some(Number.isNaN)) {
    gates.push({ name: 'first-attempt success', status: 'UNMEASURED', detail: 'missing runs' });
  } else {
    const gap = Number.isNaN(b2Rate) ? 0 : Math.abs(bRate - b2Rate);
    const floor = bRate - gap;
    gates.push({
      name: 'first-attempt success >= BASE - |BASE-BASE2|',
      status: cRate >= floor - 1e-12 ? 'PASS' : 'FAIL',
      detail: `${candidate} ${(cRate * 100).toFixed(0)}% vs floor ${(floor * 100).toFixed(0)}% (BASE ${(bRate * 100).toFixed(0)}%, BASE2 ${Number.isNaN(b2Rate) ? 'n/a' : (b2Rate * 100).toFixed(0) + '%'}, gap ${(gap * 100).toFixed(0)} pts)`,
    });
  }

  // 3. MAX_TOKENS + timeouts per stage <= BASE
  gates.push(stageGate('MAX_TOKENS + timeouts per stage <= BASE', runRows, candidate, base, mode, s => s.maxTokens + s.timeouts, 'MAX_TOKENS+timeouts'));
  // 4. schema/parse failures <= BASE
  gates.push(stageGate('parse failures per stage <= BASE', runRows, candidate, base, mode, s => s.parseFailures, 'parse failures'));

  // 5. ground truth: no FAIL (seeded catch + job_tracker must_catch)
  const comparisons: CandidateEvaluation['comparisons'] = [];
  const add = (label: string, measure: Measure, size: SizeFilter) => {
    const cmp = compareArms(data, runRows, gt, candidate, base, mode, measure, size, seed);
    comparisons.push({ label, size, cmp });
    return cmp;
  };
  const gtSeeded = add('seeded-bug catch rate', 'seededCatch', 'all');
  const gtMust = add('must_catch (job_tracker audit)', 'mustCatch', 'all');
  const gtVerdicts = [gtSeeded.verdict, gtMust.verdict];
  const gtVerdict: Verdict = gtVerdicts.includes('FAIL') ? 'FAIL' : gtVerdicts.includes('WARN') ? 'WARN'
    : gtVerdicts.every(v => v === 'UNMEASURED') ? 'UNMEASURED' : 'PASS';
  gates.push({
    name: 'ground truth: no FAIL',
    status: gtVerdict === 'FAIL' ? 'FAIL' : gtVerdict === 'UNMEASURED' ? 'UNMEASURED' : 'PASS',
    detail: `seeded: ${gtSeeded.verdict} (${gtSeeded.reason}); must_catch: ${gtMust.verdict} (${gtMust.reason})`,
  });

  // 6. must_not_flag_high: no more false alarms than BASE
  const falseAlarms = (arm: string) => gt.filter(g => g.arm === arm && g.mode === mode && g.kind === 'must_not_flag_high');
  const cFa = falseAlarms(candidate), bFa = falseAlarms(base);
  if (cFa.length === 0 || bFa.length === 0) {
    gates.push({ name: 'must_not_flag_high: false alarms <= BASE', status: 'UNMEASURED', detail: 'no must_not_flag_high entries were scored in this batch' });
  } else {
    const cn = cFa.filter(g => !g.caught).length, bn = bFa.filter(g => !g.caught).length;
    gates.push({ name: 'must_not_flag_high: false alarms <= BASE', status: cn <= bn ? 'PASS' : 'FAIL', detail: `${candidate} ${cn} vs BASE ${bn} flagged HIGH (${cFa.length} entries each run)` });
  }

  // Large-PR recall (decision rule input), plus the secondary comparisons that go in the tables.
  const largeRecall = add('recall of BASE findings', 'recallOfBase', 'large');
  for (const size of SIZE_FILTERS) {
    add('valid findings', 'valid', size);
    if (size !== 'large') add('recall of BASE findings', 'recallOfBase', size);
  }
  return { candidate, mode, gates, comparisons, groundTruthVerdict: gtVerdict, largeRecallVerdict: largeRecall.verdict };
}

// ---- judge records ----------------------------------------------------------------------------------

export type JudgeVerdict = 'win' | 'loss' | 'tie' | 'invalid';

export interface JudgeRecord {
  schema: number;
  batch_id: string;
  pr: string; rep: number; candidate: string; baseline: string; mode: Mode;
  judge_index: 1 | 2;
  judge_requested: string;
  judge_served?: string;
  swapped: boolean;
  plausible: boolean;
  reason?: string;
  candidate_metrics?: { actionability: number; falsePositives: number; uniqueFindings: number };
  baseline_metrics?: { actionability: number; falsePositives: number; uniqueFindings: number };
  verdict: JudgeVerdict;
}

// Pre-registered verdict: higher actionability wins; on equal actionability, fewer judged false
// positives wins; otherwise a tie.
export function verdictFromMetrics(c: { actionability: number; falsePositives: number }, b: { actionability: number; falsePositives: number }): JudgeVerdict {
  if (c.actionability !== b.actionability) return c.actionability > b.actionability ? 'win' : 'loss';
  if (c.falsePositives !== b.falsePositives) return c.falsePositives < b.falsePositives ? 'win' : 'loss';
  return 'tie';
}

export interface AgreedJudging {
  candidate: string; mode: Mode;
  pairs: number;          // (pr, rep) pairs with both judges' records
  agreed: { win: number; loss: number; tie: number };
  disagreed: number;
  invalid: number;        // pairs where either judge's record is invalid
  disagreements: Array<{ pr: string; rep: number; judge1: JudgeVerdict; judge2: JudgeVerdict }>;
}

// Counts only the verdicts both judges agree on. A judge verdict from a model other than the one
// requested, an implausible score block, or a missing record makes the pair invalid (not agreed,
// not a disagreement).
export function agreeJudging(records: JudgeRecord[], candidate: string, mode: Mode): AgreedJudging {
  const mine = records.filter(r => r.candidate === candidate && r.mode === mode);
  const keys = Array.from(new Set(mine.map(r => `${r.pr}#${r.rep}`)));
  const out: AgreedJudging = { candidate, mode, pairs: 0, agreed: { win: 0, loss: 0, tie: 0 }, disagreed: 0, invalid: 0, disagreements: [] };
  for (const key of keys) {
    const [pr, repStr] = [key.slice(0, key.lastIndexOf('#')), key.slice(key.lastIndexOf('#') + 1)];
    const j1 = mine.find(r => r.pr === pr && String(r.rep) === repStr && r.judge_index === 1);
    const j2 = mine.find(r => r.pr === pr && String(r.rep) === repStr && r.judge_index === 2);
    out.pairs++;
    const valid = (j?: JudgeRecord) => !!j && j.verdict !== 'invalid' && j.plausible && (!j.judge_served || j.judge_served === j.judge_requested || j.judge_served === `models/${j.judge_requested}`);
    if (!valid(j1) || !valid(j2)) { out.invalid++; continue; }
    if (j1!.verdict === j2!.verdict) out.agreed[j1!.verdict as 'win' | 'loss' | 'tie']++;
    else { out.disagreed++; out.disagreements.push({ pr, rep: Number(repStr), judge1: j1!.verdict, judge2: j2!.verdict }); }
  }
  return out;
}

// ---- decision ---------------------------------------------------------------------------------------

export type Decision = 'ADOPT' | 'DO NOT ADOPT' | 'UNDETERMINED';

export function decide(ev: CandidateEvaluation, judging: AgreedJudging | undefined): { decision: Decision; reasons: string[] } {
  const reasons: string[] = [];
  let failed = false, unmeasured = false;
  for (const g of ev.gates) {
    if (g.status === 'FAIL') { failed = true; reasons.push(`gate failed: ${g.name}`); }
    else if (g.status === 'UNMEASURED') { unmeasured = true; reasons.push(`gate unmeasured: ${g.name}`); }
  }
  // WARN is not a pass: ground truth and large-PR recall must both be clean PASSes.
  for (const [label, v] of [['ground truth', ev.groundTruthVerdict], ['large-PR recall', ev.largeRecallVerdict]] as const) {
    if (v === 'FAIL' || v === 'WARN') { failed = true; reasons.push(`${label}: ${v}`); }
    else if (v === 'UNMEASURED') { unmeasured = true; reasons.push(`${label}: UNMEASURED`); }
  }
  if (!judging || judging.pairs === 0) { unmeasured = true; reasons.push('no judged pairs'); }
  else if (judging.agreed.win < judging.agreed.loss) { failed = true; reasons.push(`agreed judge verdicts: ${judging.agreed.win} wins < ${judging.agreed.loss} losses`); }
  if (failed) return { decision: 'DO NOT ADOPT', reasons };
  if (unmeasured) return { decision: 'UNDETERMINED', reasons };
  return { decision: 'ADOPT', reasons: ['every gate passed; no FAIL/WARN on ground truth or large-PR recall; agreed judge wins >= losses'] };
}

// ---- summaries for the tables --------------------------------------------------------------------------

export function summarize(xs: number[]): { n: number; mean: number; p50: number; p95: number } {
  const f = xs.filter(Number.isFinite);
  return { n: f.length, mean: f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN, p50: percentile(f, 50), p95: percentile(f, 95) };
}

export { loadSeededFixture };
