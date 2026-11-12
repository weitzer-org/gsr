// Pairwise LLM judging for a comparison batch: each candidate (and the A/A control) against BASE,
// per mode (basic findings, swarm findings), per (PR, repetition), by TWO judges. Only verdicts
// both judges agree on are counted (analysis.ts agreeJudging); disagreements are reported.
//
//   npx ts-node judge-batch.ts <batch-dir>                   dry run: prints the call count
//   EVAL_MAX_JUDGE_CALLS=40 npx ts-node judge-batch.ts <batch-dir> --live
//
// Judge 1 = JUDGE_MODEL (default gemini-2.5-pro). Judge 2 = JUDGE_MODEL_2 (default gemini-3.8-flash),
// but never a model that is IN the pair being judged: when it is, the first alternate that is not
// (JUDGE_MODEL_2_ALTERNATES, default gemini-4-argon) is used instead and the choice is recorded.
// The reviewers are shown under blind labels ("Reviewer 1"/"Reviewer 2", no arm or model names),
// and which one is shown first is randomized per call from a seeded RNG and un-swapped afterwards.
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { loadBatch, BatchData, writeJson, SCHEMA, RunRecord } from './batch';
import { MODES, Mode, JudgeRecord, verdictFromMetrics, findingsOfMode } from './analysis';
import { CallBudget, requireCap } from './budget';
import { validateFindingsAgainstDiff } from './validation';
import { compareResultsWithLLMV2, DEFAULT_JUDGE_MODEL } from './llm-comparator-v2';
import { makeRng } from './stats';
import { hashSeed } from './compare-arms';

export interface JudgeTask {
  pr: string; slug: string; rep: number; candidate: string; baseline: string; mode: Mode;
  judgeIndex: 1 | 2; judgeModel: string; file: string;
}

export function pickSecondJudge(pairModels: ReadonlySet<string>, preferred: string, alternates: readonly string[]): string {
  if (!pairModels.has(preferred)) return preferred;
  const alt = alternates.find(a => !pairModels.has(a));
  if (!alt) throw new Error(`No second judge available that is not in the pair {${[...pairModels].join(', ')}}.`);
  return alt;
}

function armModels(data: BatchData, arm: string): string[] {
  return Object.values(data.manifest.arms.find(a => a.name === arm)?.routing.stageModels ?? {});
}

export function judgeFileName(slug: string, rep: number, cand: string, base: string, mode: Mode, idx: 1 | 2): string {
  return `${slug}__rep${rep}__${cand}-vs-${base}__${mode}__j${idx}.json`;
}

export function planJudging(
  data: BatchData,
  opts: { judge1: string; judge2: string; alternates: string[]; modes?: readonly Mode[]; only?: string[] }
): JudgeTask[] {
  const base = data.manifest.baseline_arm;
  const cands = data.manifest.arms.map(a => a.name).filter(n => n !== base && (!opts.only || opts.only.includes(n)));
  const tasks: JudgeTask[] = [];
  const runAt = (arm: string, pr: string, rep: number): RunRecord | undefined => data.runs.find(r => r.arm === arm && r.pr === pr && r.rep === rep);
  for (const pr of data.manifest.prs) {
    for (let rep = 1; rep <= data.manifest.reps; rep++) {
      const b = runAt(base, pr.url, rep);
      if (!b?.result) continue;
      for (const cand of cands) {
        const c = runAt(cand, pr.url, rep);
        if (!c?.result) continue;
        const pair = new Set([...armModels(data, cand), ...armModels(data, base)]);
        const j2 = pickSecondJudge(pair, opts.judge2, opts.alternates);
        for (const mode of opts.modes ?? MODES) {
          for (const [idx, model] of [[1, opts.judge1], [2, j2]] as const) {
            tasks.push({ pr: pr.url, slug: pr.slug, rep, candidate: cand, baseline: base, mode, judgeIndex: idx, judgeModel: model, file: judgeFileName(pr.slug, rep, cand, base, mode, idx) });
          }
        }
      }
    }
  }
  return tasks;
}

// The judge returns scores for the slots it was shown; swapped means slot 1 held the baseline.
export function unswapMetrics<T>(slot1: T, slot2: T, swapped: boolean): { candidate: T; baseline: T } {
  return swapped ? { candidate: slot2, baseline: slot1 } : { candidate: slot1, baseline: slot2 };
}

export async function runJudgeTask(
  data: BatchData, task: JudgeTask, batchSeed: number,
  judge: typeof compareResultsWithLLMV2 = compareResultsWithLLMV2
): Promise<JudgeRecord> {
  const candRun = data.runs.find(r => r.arm === task.candidate && r.pr === task.pr && r.rep === task.rep)!;
  const baseRun = data.runs.find(r => r.arm === task.baseline && r.pr === task.pr && r.rep === task.rep)!;
  const diff = data.diffs.get(task.slug) ?? [];
  // Judge only findings that survive diff validation, as evaluate.ts's v2 flow does.
  const candF = validateFindingsAgainstDiff(findingsOfMode(candRun.result!.findings, task.mode), diff).validFindings;
  const baseF = validateFindingsAgainstDiff(findingsOfMode(baseRun.result!.findings, task.mode), diff).validFindings;
  // Seeded by (batch seed, pair, mode) but NOT by judge index, so both judges see the same order
  // for a pair — disagreement then reflects the judges, not the order they were shown.
  const swapped = makeRng(hashSeed(batchSeed, task.slug, String(task.rep), task.candidate, task.mode))() < 0.5;
  const [first, second] = swapped ? [baseF, candF] : [candF, baseF];
  const rec: JudgeRecord = {
    schema: SCHEMA, batch_id: data.manifest.batch_id, pr: task.pr, rep: task.rep, candidate: task.candidate, baseline: task.baseline,
    mode: task.mode, judge_index: task.judgeIndex, judge_requested: task.judgeModel, swapped, plausible: false, verdict: 'invalid',
  };
  try {
    const res = await judge(task.pr, first, second, [], [], 'Reviewer 1', 'Reviewer 2', { model: task.judgeModel });
    rec.judge_served = res.judgeServedModel;
    rec.plausible = res.plausible;
    if (!res.plausible) rec.reason = res.implausibleReason;
    const { candidate, baseline } = unswapMetrics(res.metrics.targetA, res.metrics.targetB, swapped);
    rec.candidate_metrics = candidate;
    rec.baseline_metrics = baseline;
    rec.verdict = res.plausible ? verdictFromMetrics(candidate, baseline) : 'invalid';
  } catch (e: any) {
    rec.reason = `judge call failed: ${String(e?.message ?? e).slice(0, 300)}`;
  }
  return rec;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: ts-node judge-batch.ts <batch-dir> [--live] [--only ARM,ARM] [--modes basic,subagent]');
  const data = loadBatch(dir);
  const judge1 = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const judge2 = process.env.JUDGE_MODEL_2 || 'gemini-3.8-flash';
  const alternates = (process.env.JUDGE_MODEL_2_ALTERNATES || 'gemini-4-argon').split(',').map(s => s.trim()).filter(Boolean);
  const onlyIdx = process.argv.indexOf('--only');
  const modesIdx = process.argv.indexOf('--modes');
  const tasks = planJudging(data, {
    judge1, judge2, alternates,
    only: onlyIdx > 0 ? process.argv[onlyIdx + 1].split(',') : undefined,
    modes: modesIdx > 0 ? (process.argv[modesIdx + 1].split(',') as Mode[]) : undefined,
  });
  const todo = tasks.filter(t => !fs.existsSync(path.join(dir, 'judge', t.file)));
  const byJudge = new Map<string, number>();
  for (const t of todo) byJudge.set(t.judgeModel, (byJudge.get(t.judgeModel) ?? 0) + 1);
  console.log(`Batch ${data.manifest.batch_id}: ${tasks.length} judge calls planned, ${todo.length} not yet done. By judge: ${[...byJudge].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (!process.argv.includes('--live')) { console.log('DRY RUN: nothing was called. Add --live with EVAL_MAX_JUDGE_CALLS=N.'); return; }
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required.');
  const budget = new CallBudget('judge calls', requireCap('EVAL_MAX_JUDGE_CALLS', process.env.EVAL_MAX_JUDGE_CALLS));
  const concurrency = Number(process.env.EVAL_JUDGE_CONCURRENCY || '4');
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++];
      budget.take();
      const rec = await runJudgeTask(data, t, data.manifest.seed);
      writeJson(path.join(dir, 'judge', t.file), rec);
      console.log(`  ${t.candidate} ${t.mode} ${t.slug}#${t.rep} j${t.judgeIndex} (${t.judgeModel}): ${rec.verdict}${rec.reason ? ` — ${rec.reason}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  console.log(`Done. ${budget.callsUsed} judge call(s).`);
}

if (require.main === module) {
  main().catch(err => { console.error('\n💥', err.message ?? err); process.exitCode = 1; });
}
