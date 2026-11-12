// Report generator: `npx ts-node report.ts <batch-dir>` reads a comparison batch and writes
// <batch-dir>/report.md and <batch-dir>/report.json. Offline: no model calls, no network. Every
// number can be recomputed from the batch directory, which is what an independent verifier does.
import * as fs from 'fs';
import * as path from 'path';
import { loadBatch, BatchData, assertSameBatch, writeJson, costOfMetrics, ServedPins } from './batch';
import {
  computeRunMetrics, computeGroundTruth, computeReliability, evaluateCandidate, agreeJudging, decide, summarize,
  MODES, SIZE_FILTERS, Mode, JudgeRecord, RunMetrics, GroundTruthRow, CandidateEvaluation, AgreedJudging, acceptedRuns,
} from './analysis';
import { loadSeededFixture, SeededFixture } from './groundtruth';
import { Fixture } from './fixture-regression';
import { MeasureComparison } from './stats';

const PRICE_DATES: Array<{ label: string; at: Date }> = [
  { label: 'today', at: new Date() },
  { label: 'from 2026-12-01 (Argon $4/$20)', at: new Date('2026-12-01T00:00:00Z') },
  { label: 'from 2027-01-01 (3.8 Flash $1.50/$7.50)', at: new Date('2027-01-01T00:00:00Z') },
];

export interface ReportInputs {
  data: BatchData;
  judge: JudgeRecord[];
  seeded?: SeededFixture;
  jobTracker?: Fixture;
  pins?: ServedPins;
}

function md(headers: string[], rows: Array<Array<string | number | boolean>>): string {
  const esc = (x: string | number | boolean) => String(x).replace(/\|/g, '\\|');
  return [
    `| ${headers.map(esc).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a');
const sec = (ms: number) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(0)}s` : 'n/a');
const modeName = (m: Mode) => (m === 'subagent' ? 'swarm' : 'basic');

function cmpRow(label: string, size: string, c: MeasureComparison): Array<string | number> {
  const unit = c.changeUnit === '%' ? '%' : ' pts';
  return [
    label, size, c.n, f2(c.meanBase), f2(c.meanCand), `${c.lower}/${c.higher}/${c.equal}`, c.signP.toFixed(3),
    Number.isFinite(c.ci[0]) ? `[${f1(c.ci[0])}, ${f1(c.ci[1])}]${unit}` : 'n/a',
    c.verdict,
  ];
}

export function buildReport(inp: ReportInputs): { markdown: string; json: any } {
  const { data } = inp;
  const m = data.manifest;
  const rows = computeRunMetrics(data, { pins: inp.pins });
  const gt = computeGroundTruth(data, inp.seeded, inp.jobTracker);
  const rel = computeReliability(data);
  const base = m.baseline_arm;
  const candidates = m.arms.filter(a => a.name !== base && a.name !== m.control_arm).map(a => a.name);
  const out: string[] = [];
  const json: any = { batch_id: m.batch_id };

  out.push(`# Model-upgrade eval report — ${m.batch_id}`);
  out.push('');
  out.push(`Generated from \`${path.basename(data.dir)}\` by tools/eval/report.ts. Every number below is recomputable from that directory.`);
  out.push('');

  // ---- 1. what ran --------------------------------------------------------------------------
  out.push('## 1. What ran');
  out.push('');
  out.push(md(['field', 'value'], [
    ['batch_id', m.batch_id], ['git commit', `${m.git.commit}${m.git.dirty ? ' (dirty tree)' : ''} on ${m.git.branch}`],
    ['created', m.created_at], ['finished', m.finished_at ?? '(not finished)'],
    ['execution mode', m.environment.execution_mode], ['concurrency', `${m.concurrency.arms_in_flight} arms in flight per (PR, rep); ${m.concurrency.per_backend}. ${m.concurrency.note}`],
    ['PRs', `${m.prs.length} (${m.prs.filter(p => p.size_class === 'small').length} small, ${m.prs.filter(p => p.size_class === 'large').length} large ≥10 changed files)`],
    ['excluded PRs', m.excluded_prs.length ? m.excluded_prs.map(e => `${e.url} (${e.reason})`).join('; ') : 'none'],
    ['repetitions', m.reps], ['seed', m.seed], ['max attempts per run', m.max_attempts], ['attempt timeout', `${m.attempt_timeout_ms / 1000}s`],
    ['review-call cap', m.max_review_calls],
  ]));
  out.push('');
  out.push(md(['arm', 'role', 'discovery', 'remediation', 'basic', 'deduplicate', 'evaluate', 'thinking level', 'max output', 'caching'],
    m.arms.map(a => [a.name, a.role ?? 'candidate', a.routing.stageModels.discovery, a.routing.stageModels.remediation, a.routing.stageModels.basic,
      a.routing.stageModels.deduplicate, a.routing.stageModels.evaluate, a.routing.thinkingLevel ?? 'default (none sent)', a.routing.maxOutputTokens ?? 'none', a.routing.contextCaching])));
  out.push('');
  out.push('Routing above is what each server reported on `/api/status` before any review ran (checked against the resolver; a mismatch aborts the batch).');
  out.push('');

  // ---- 2. integrity ---------------------------------------------------------------------------
  out.push('## 2. Integrity');
  out.push('');
  out.push('### Reliability (one HTTP review per run; both modes share it)');
  out.push('');
  out.push(md(['arm', 'runs', 'first attempt complete', 'first attempt clean (no stage flag)', 'retries', 'never completed', 'attempt outcomes (all attempts)'],
    rel.map(r => [r.arm, r.runs, `${r.firstAttemptComplete}/${r.runs} (${pct(r.firstAttemptComplete / r.runs)})`, `${r.firstAttemptClean}/${r.runs} (${pct(r.firstAttemptClean / r.runs)})`,
      r.totalRetries, r.neverCompleted, Object.entries(r.outcomes).map(([k, v]) => `${k}:${v}`).join(' ')])));
  out.push('');
  out.push('"Complete" = a `done` frame with >0 calls. Only an incomplete attempt is retried; a complete attempt with stage flags (MAX_TOKENS, parse failure, stage timeout, served-model mismatch) is **kept**, flagged, and counted in the tables below — retrying those would select for luck.');
  out.push('');
  out.push('### Per-stage calls and flags (accepted results only; shared = the evaluate call, counted under both modes)');
  out.push('');
  const stageRows: Array<Array<string | number>> = [];
  for (const arm of m.arms.map(a => a.name)) for (const mode of MODES) {
    const agg: Record<string, { calls: number; maxTokens: number; timeouts: number; parse: number; err: number; mism: number; think: number }> = {};
    for (const r of rows.filter(x => x.arm === arm && x.mode === mode)) for (const [st, s] of Object.entries(r.stages)) {
      const a = (agg[st] ??= { calls: 0, maxTokens: 0, timeouts: 0, parse: 0, err: 0, mism: 0, think: 0 });
      a.calls += s.calls; a.maxTokens += s.maxTokens; a.timeouts += s.timeouts; a.parse += s.parseFailures; a.err += s.apiErrors; a.mism += s.servedMismatches; a.think += s.thinkingTokens;
    }
    for (const [st, a] of Object.entries(agg)) stageRows.push([arm, modeName(mode), st, a.calls, a.maxTokens, a.timeouts, a.parse, a.err, a.mism, a.think]);
  }
  out.push(stageRows.length ? md(['arm', 'mode', 'stage', 'calls', 'MAX_TOKENS', 'timeouts', 'parse failures', 'API errors (non-timeout)', 'served-model mismatches', 'thinking tokens'], stageRows) : '_no accepted runs_');
  out.push('');

  // ---- 3. volume, hallucination ----------------------------------------------------------------
  out.push('## 3. Findings: volume and hallucination (per arm × mode × size class)');
  out.push('');
  out.push('Hallucinated = does not survive `validateFindingsAgainstDiff` (the file is not in the PR diff, or the line is not an ADDED line of its hunks; context lines are rejected). Basic and swarm findings are reported separately: basic findings never go through the deduplicator.');
  out.push('');
  const volRows: Array<Array<string | number>> = [];
  for (const arm of m.arms.map(a => a.name)) for (const mode of MODES) for (const size of SIZE_FILTERS) {
    const rs = rows.filter(r => r.arm === arm && r.mode === mode && (size === 'all' || r.size === size));
    if (!rs.length) continue;
    const tot = rs.reduce((s, r) => s + r.findings, 0), hal = rs.reduce((s, r) => s + r.hallucinated, 0);
    volRows.push([arm, modeName(mode), size, rs.length, f1(summarize(rs.map(r => r.findings)).mean), f1(summarize(rs.map(r => r.valid)).mean), f1(summarize(rs.map(r => r.high)).mean), `${hal}/${tot} (${tot ? pct(hal / tot) : 'n/a'})`]);
  }
  out.push(volRows.length ? md(['arm', 'mode', 'size', 'runs', 'findings/run', 'valid/run', 'valid HIGH+/run', 'hallucinated'], volRows) : '_no accepted runs_');
  out.push('');

  // ---- 4. recall -----------------------------------------------------------------------------------
  out.push('## 4. Recall against BASE, both directions (secondary measure)');
  out.push('');
  out.push('`recall of BASE` = share of BASE\'s valid findings (same PR, same repetition) that this arm also reports within ±10 lines (greedy 1:1). `BASE recall of arm` = share of this arm\'s valid findings BASE also reports. It rewards whichever model writes more; ground truth (§5) is the precision/recall measure that matters. BASE2 is the A/A noise floor, and in §8 the recall of each candidate is compared with the control\'s recall of BASE (BASE\'s own recall of itself is trivially 100%).');
  out.push('');
  const recRows: Array<Array<string | number>> = [];
  for (const arm of m.arms.map(a => a.name).filter(a => a !== base)) for (const mode of MODES) for (const size of SIZE_FILTERS) {
    const rs = rows.filter(r => r.arm === arm && r.mode === mode && (size === 'all' || r.size === size));
    if (!rs.length) continue;
    recRows.push([arm, modeName(mode), size, rs.length, pct(summarize(rs.map(r => r.recallOfBase ?? NaN)).mean), pct(summarize(rs.map(r => r.baseRecallOfThis ?? NaN)).mean)]);
  }
  out.push(recRows.length ? md(['arm', 'mode', 'size', 'runs', 'recall of BASE', 'BASE recall of arm'], recRows) : '_no data_');
  out.push('');

  // ---- 5. ground truth -------------------------------------------------------------------------------
  out.push('## 5. Ground truth');
  out.push('');
  const gtRows: Array<Array<string | number>> = [];
  const kinds: GroundTruthRow['kind'][] = ['seeded', 'must_catch', 'must_not_flag_high', 'must_resolve_cross_file'];
  for (const arm of m.arms.map(a => a.name)) for (const mode of MODES) for (const kind of kinds) {
    const rs = gt.filter(g => g.arm === arm && g.mode === mode && g.kind === kind);
    if (!rs.length) continue;
    const pass = rs.filter(g => g.caught).length;
    const label = kind === 'seeded' ? 'seeded bug caught' : kind === 'must_not_flag_high' ? 'must_not_flag_high (passes; a fail = false alarm)' : kind;
    const extra = kind === 'seeded' ? `${rs.reduce((s, g) => s + (g.highUnmatched ?? 0), 0)} unmatched HIGH+ findings on seeded PRs (potential false alarms, informational)` : '';
    gtRows.push([arm, modeName(mode), label, `${pass}/${rs.length} (${pct(pass / rs.length)})`, extra]);
  }
  out.push(gtRows.length ? md(['arm', 'mode', 'check', 'caught / passed', 'note'], gtRows) : '**UNMEASURED.** None of the ground-truth PRs (the 10 seeded `gemini-cli-fork` PRs, the `job_tracker` audit PRs) were part of this batch.');
  out.push('');
  const inBatch = new Set(m.prs.map(p => p.url));
  const seedPrs = inp.seeded ? Array.from(new Set(inp.seeded.entries.map(e => e.prUrl))) : [];
  const missing = seedPrs.filter(u => !inBatch.has(u));
  if (inp.seeded) out.push(`Seeded-bug PRs in this batch: ${seedPrs.length - missing.length}/${seedPrs.length}.${missing.length ? ` Not in the batch: ${missing.length}.` : ''} Known limitation: every seeded diff has an \`// INTENTIONAL DEFECT\` comment beside the bug, so catching it is easy; a miss is informative, a hit proves little.`);
  out.push('');

  // ---- 6. judge ---------------------------------------------------------------------------------------
  out.push('## 6. LLM-judge verdicts (only verdicts BOTH judges agree on)');
  out.push('');
  const judgings: Record<string, AgreedJudging> = {};
  const jRows: Array<Array<string | number>> = [];
  const judgeCandidates = [...candidates, ...(m.control_arm ? [m.control_arm] : [])];
  for (const c of judgeCandidates) for (const mode of MODES) {
    const j = agreeJudging(inp.judge, c, mode);
    judgings[`${c}|${mode}`] = j;
    if (j.pairs) jRows.push([c, modeName(mode), j.pairs, j.agreed.win, j.agreed.loss, j.agreed.tie, j.disagreed, j.invalid]);
  }
  out.push(jRows.length ? md(['arm vs BASE', 'mode', 'judged pairs', 'agreed wins', 'agreed losses', 'agreed ties', 'judges disagree', 'invalid/missing'], jRows) : '_No judge records in this batch (judge-batch.ts has not been run)._');
  out.push('');
  const judgeModels = new Set(inp.judge.map(j => `${j.judge_index}:${j.judge_requested}`));
  if (judgeModels.size) out.push(`Judges used: ${[...judgeModels].sort().join(', ')}. Judge order is randomized per call and un-swapped before scoring. A record whose judge was served by a different model than requested is invalid.`);
  out.push('');

  // ---- 7. latency, thinking, cost -------------------------------------------------------------------------
  out.push('## 7. Latency, thinking tokens and cost');
  out.push('');
  out.push(`All arms in this batch ran in one execution mode (${m.environment.execution_mode}) at the same concurrency (${m.concurrency.arms_in_flight} arms in flight per PR/rep), so they are comparable with each other. They are **not** comparable with latency or cost from any other batch, execution mode, or concurrency level. Latency uses only runs accepted on the first attempt (retries run under different load).`);
  out.push('');
  const lcRows: Array<Array<string | number>> = [];
  const accepted = acceptedRuns(data);
  for (const arm of m.arms.map(a => a.name)) {
    const runs = accepted.filter(r => r.arm === arm);
    if (!runs.length) continue;
    const firsts = runs.filter(r => r.accepted_attempt === 1);
    const wall = summarize(firsts.map(r => r.result!.metrics?.durationMs));
    const costs = PRICE_DATES.map(d => {
      const per = runs.map(r => costOfMetrics(r.result!.metrics, d.at));
      const unknown = per.reduce((s, c) => s + c.unknownStages.length, 0);
      const usd = summarize(per.map(c => c.usd)).mean;
      return unknown ? `unknown (${unknown} stage(s) excluded)` : `$${usd.toFixed(3)}`;
    });
    const thinkExtra = summarize(runs.map(r => costOfMetrics(r.result!.metrics, PRICE_DATES[0].at).thinkingExtraUsd)).mean;
    const think = summarize(runs.map(r => costOfMetrics(r.result!.metrics, PRICE_DATES[0].at).thinkingTokens)).mean;
    lcRows.push([arm, runs.length, firsts.length, sec(wall.p50), sec(wall.p95), Math.round(think), ...costs, `+$${thinkExtra.toFixed(3)}`]);
  }
  out.push(lcRows.length ? md(['arm', 'accepted runs', 'first-attempt runs', 'review wall-clock p50', 'p95', 'thinking tokens/review', `cost/review ${PRICE_DATES[0].label}`, `cost/review ${PRICE_DATES[1].label}`, `cost/review ${PRICE_DATES[2].label}`, 'if thinking billed on top'], lcRows) : '_no accepted runs_');
  out.push('');
  out.push('Costs use recorded input/output tokens per stage × the PRICE_TABLE rate for that stage\'s requested model at the stated date (`gemini-4-argon` rows are **unverified**, see TODO.md #46). Thinking tokens are not added to cost (same convention as `usage.ts`); the last column is the upper bound if they are billed on top of output tokens. Cached tokens are zero here (caching is off on every arm).');
  out.push('');
  const modeLat: Array<Array<string | number>> = [];
  for (const arm of m.arms.map(a => a.name)) for (const mode of MODES) {
    const firstsRuns = new Set(accepted.filter(r => r.accepted_attempt === 1).map(r => `${r.pr}#${r.rep}`));
    const rs = rows.filter(r => r.arm === arm && r.mode === mode && firstsRuns.has(`${r.pr}#${r.rep}`) && r.latencyMs !== undefined);
    if (!rs.length) continue;
    const s = summarize(rs.map(r => r.latencyMs!));
    modeLat.push([arm, modeName(mode), s.n, sec(s.p50), sec(s.p95), Math.round(summarize(rs.map(r => r.thinkingTokens)).mean)]);
  }
  if (modeLat.length) { out.push(md(['arm', 'mode', 'runs', 'orchestrator wall-clock p50', 'p95', 'thinking tokens/run'], modeLat)); out.push(''); }

  // ---- 8. statistics ---------------------------------------------------------------------------------------------
  out.push('## 8. Statistics: each candidate vs BASE, per PR');
  out.push('');
  out.push('The unit is the PR (repetitions averaged within a PR first). Columns: PRs used; mean BASE; mean candidate; PRs where the candidate is lower/higher/equal; exact two-sided sign-test p; 95% bootstrap interval of the change (4000 resamples over PRs, fixed seed; % for counts, points for shares). FAIL = the whole interval is below -10. WARN = interval upper bound below 0 and sign p ≤ 0.10. **WARN is not a pass.** Fewer than 4 paired PRs: identical → PASS, otherwise UNMEASURED.');
  out.push('');
  const evals: CandidateEvaluation[] = [];
  const evalNames = [...candidates, ...(m.control_arm ? [m.control_arm] : [])];
  for (const c of evalNames) for (const mode of MODES) evals.push(evaluateCandidate(data, rows, gt, rel, c, mode));
  for (const ev of evals) {
    out.push(`### ${ev.candidate} vs ${base} — ${modeName(ev.mode)}${ev.candidate === m.control_arm ? ' (A/A control: expected to show NO difference)' : ''}`);
    out.push('');
    out.push(md(['measure', 'size', 'PRs', 'mean BASE', 'mean arm', 'lower/higher/equal', 'sign p', '95% interval of change', 'verdict'], ev.comparisons.map(c => cmpRow(c.label, c.size, c.cmp))));
    out.push('');
  }

  // ---- 9. gates and decision -------------------------------------------------------------------------------------------
  out.push('## 9. Gates and decision (pre-registered in docs/eval/model-upgrade-test-plan.md)');
  out.push('');
  const decisions: any[] = [];
  for (const ev of evals) {
    if (ev.candidate === m.control_arm) {
      // The control's job is to show the gates do not fire on pure noise; report, don't decide.
      out.push(`### ${ev.candidate} (A/A control) — ${modeName(ev.mode)}`);
      out.push('');
      out.push(md(['gate', 'status', 'detail'], ev.gates.map(g => [g.name, g.status, g.detail])));
      out.push('');
      continue;
    }
    const d = decide(ev, judgings[`${ev.candidate}|${ev.mode}`]);
    decisions.push({ candidate: ev.candidate, mode: ev.mode, ...d });
    out.push(`### ${ev.candidate} — ${modeName(ev.mode)}: **${d.decision}**`);
    out.push('');
    out.push(md(['gate', 'status', 'detail'], ev.gates.map(g => [g.name, g.status, g.detail])));
    out.push('');
    out.push(`Ground truth: ${ev.groundTruthVerdict}; large-PR recall: ${ev.largeRecallVerdict}. ${d.reasons.map(r => `- ${r}`).join(' ')}`);
    out.push('');
  }
  out.push('Cost and latency only break ties; they never outweigh a quality loss.');
  out.push('');

  json.arms = m.arms.map(a => ({ name: a.name, routing: a.routing }));
  json.reliability = rel;
  json.runMetrics = rows;
  json.groundTruth = gt;
  json.evaluations = evals;
  json.judging = judgings;
  json.decisions = decisions;
  return { markdown: out.join('\n'), json };
}

export function loadJudgeRecords(dir: string, batchId: string): JudgeRecord[] {
  const jd = path.join(dir, 'judge');
  if (!fs.existsSync(jd)) return [];
  return fs.readdirSync(jd).filter(f => f.endsWith('.json')).sort().map(f => {
    const rec: JudgeRecord = JSON.parse(fs.readFileSync(path.join(jd, f), 'utf8'));
    assertSameBatch(`judge/${f}`, batchId, rec.batch_id);
    return rec;
  });
}

function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: ts-node report.ts <batch-dir> [--pins file.json]'); process.exit(2); }
  const data = loadBatch(dir);
  const pinsIdx = process.argv.indexOf('--pins');
  const pins: ServedPins | undefined = pinsIdx > 0 ? JSON.parse(fs.readFileSync(process.argv[pinsIdx + 1], 'utf8')) : undefined;
  const seeded = loadSeededFixture();
  const jtPath = path.join(__dirname, 'fixtures', 'job_tracker_regressions.json');
  const jobTracker: Fixture | undefined = fs.existsSync(jtPath) ? JSON.parse(fs.readFileSync(jtPath, 'utf8')) : undefined;
  const { markdown, json } = buildReport({ data, judge: loadJudgeRecords(dir, data.manifest.batch_id), seeded, jobTracker, pins });
  fs.writeFileSync(path.join(dir, 'report.md'), markdown);
  writeJson(path.join(dir, 'report.json'), json);
  console.log(`Wrote ${path.join(dir, 'report.md')} and report.json`);
}

if (require.main === module) main();
