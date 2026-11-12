// On-disk format of a multi-arm comparison batch, plus the guards that keep results from different
// batches from ever being compared.
//
//   <batch>/manifest.json                      batch_id, git commit, every arm's resolved routing, PR list, settings
//   <batch>/diffs/<pr-slug>.json               the PR's diff chunks (so the report is reproducible offline)
//   <batch>/runs/<pr-slug>__rep<N>__<ARM>.json one RunRecord: every attempt, and the accepted result
//   <batch>/judge/<...>.json                   one JudgeRecord per judged pair (judge-batch.ts)
//   <batch>/logs/<ARM>.log                     the arm's server log
import * as fs from 'fs';
import * as path from 'path';
import { ReviewFinding } from './api-client';
import { DiffChunk } from './validation';
import { computeCostUsd, isModelPriced } from './usage';
import { ArmConfig } from './arms';

export const SCHEMA = 1;
export const LARGE_PR_MIN_FILES = 10;

export interface ManifestArm extends ArmConfig {
  port: number;
  routing: { stageModels: Record<string, string>; maxOutputTokens: number | null; thinkingLevel: string | null; contextCaching: boolean };
  status_snapshot?: unknown; // what the running server's /api/status actually reported
}

export interface ManifestPr {
  url: string;
  slug: string;
  changed_files: number;      // files in the diff after the backend's own ignore filter (what the review sees)
  size_class: 'small' | 'large';
  group: string;              // 'config' | 'large_set' | 'smoke' | ... — where the PR came from
}

export interface Manifest {
  schema: number;
  batch_id: string;
  created_at: string;
  finished_at?: string;
  git: { commit: string; branch: string; dirty: boolean };
  environment: { node: string; platform: string; execution_mode: string; hostname_redacted: true };
  concurrency: { arms_in_flight: number; per_backend: string; note: string };
  arms: ManifestArm[];
  baseline_arm: string;
  control_arm?: string;
  prs: ManifestPr[];
  excluded_prs: Array<{ url: string; reason: string }>;
  reps: number;
  seed: number;
  start_order: Record<string, string[]>;     // "<pr-slug>#<rep>" -> arm start order
  max_attempts: number;
  attempt_timeout_ms: number;
  max_review_calls: number;
  settings: Record<string, string>;          // non-secret harness settings
}

export type AttemptOutcome = 'success' | 'timeout' | 'error' | 'parse_failure' | 'max_tokens' | 'served_model_mismatch' | 'stage_timeout' | 'stage_error';

export interface Attempt {
  n: number;
  started_at: string;
  duration_ms: number;
  complete: boolean;          // a `done` frame with calls > 0 came back
  outcome: AttemptOutcome;    // 'success' = complete AND no stage flag
  flags: string[];            // stage flags seen on a complete attempt
  error?: string;
  concurrent_arms: number;    // first attempt: arms started together for this (PR, rep); retry: attempts then in flight
}

export interface RunRecord {
  schema: number;
  batch_id: string;
  arm: string;
  pr: string;                 // PR url
  pr_slug: string;
  rep: number;
  attempts: Attempt[];
  first_attempt_complete: boolean;
  first_attempt_clean: boolean;
  retries: number;            // attempts - 1
  accepted_attempt: number | null;   // the FIRST complete attempt; later attempts are never run once one is complete
  result: null | {
    findings: ReviewFinding[];
    metrics: any;
    evaluation?: string;
  };
}

export interface BatchData {
  dir: string;
  manifest: Manifest;
  runs: RunRecord[];
  diffs: Map<string, DiffChunk[]>;
}

export class BatchMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchMismatchError';
  }
}

export function prSlug(prUrl: string): string {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub PR URL: ${prUrl}`);
  return `${m[1]}__${m[2]}__pull-${m[3]}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function runFileName(slug: string, rep: number, arm: string): string {
  return `${slug}__rep${rep}__${arm}.json`;
}

export function sizeClassOf(changedFiles: number): 'small' | 'large' {
  return changedFiles >= LARGE_PR_MIN_FILES ? 'large' : 'small';
}

export function newBatchId(now: Date = new Date()): string {
  return `batch-${now.toISOString().replace(/[:.]/g, '-')}`;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function loadBatch(dir: string): BatchData {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest.json in ${dir} — not a batch directory.`);
  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.batch_id) throw new BatchMismatchError(`${dir}/manifest.json has no batch_id.`);
  const runsDir = path.join(dir, 'runs');
  const runs: RunRecord[] = [];
  if (fs.existsSync(runsDir)) {
    for (const f of fs.readdirSync(runsDir).filter(f => f.endsWith('.json')).sort()) {
      const run: RunRecord = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
      if (run.batch_id !== manifest.batch_id) {
        throw new BatchMismatchError(`runs/${f} belongs to batch ${run.batch_id}, but the manifest is batch ${manifest.batch_id}. Refusing to mix batches.`);
      }
      runs.push(run);
    }
  }
  const diffs = new Map<string, DiffChunk[]>();
  const diffsDir = path.join(dir, 'diffs');
  if (fs.existsSync(diffsDir)) {
    for (const f of fs.readdirSync(diffsDir).filter(f => f.endsWith('.json'))) {
      diffs.set(f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(diffsDir, f), 'utf8')));
    }
  }
  return { dir, manifest, runs, diffs };
}

// Two things claimed to be comparable must come from one batch. Used by anything that takes more
// than one source (judge records, a second run directory, a baseline file).
export function assertSameBatch(label: string, expected: string, actual: string | undefined): void {
  if (actual !== expected) throw new BatchMismatchError(`${label} has batch_id ${actual ?? '<none>'}, expected ${expected}. Results from different batches are never compared.`);
}

// ---- attempt classification ----------------------------------------------------------------

export interface StageFlagCounts {
  max_tokens: number;
  parse_failure: number;
  stage_timeout: number;
  // A stage's Gemini call failed outright (network error, 5xx, 429, ...; timeouts and parse failures
  // are counted separately). The review still "completes" because the deduplicator and evaluator
  // fall back to raw findings / a canned string, so without this flag such a review looks clean.
  stage_error: number;
  served_model_mismatch: number;
}

const SOURCES = ['subagent', 'basic', 'shared'] as const;

// `pins` maps a requested model id to extra served ids that count as "the same model" (e.g. an
// alias the probe found being served under a different id). Identity is always accepted.
export type ServedPins = Record<string, string[]>;

export function stageServedMismatches(summary: any, pins: ServedPins = {}): number {
  if (!summary?.servedModels) return summary?.servedModelMismatches ?? 0;
  const requested: string[] = Object.keys(summary.requestedModels ?? {});
  if (requested.length !== 1) return summary.servedModelMismatches ?? 0; // cannot pair served to requested; trust the strict count
  const allowed = new Set([requested[0], ...(pins[requested[0]] ?? [])]);
  let bad = 0;
  for (const [served, n] of Object.entries<number>(summary.servedModels)) if (!allowed.has(served)) bad += n;
  return bad;
}

// Failed calls that are not timeouts (those have their own counter; parse failures are annotations,
// not failures, in StageCollector).
export function stageApiErrors(summary: any): number {
  const failures = summary?.failures ?? 0;
  const timeouts = summary?.errorKinds?.timeout ?? 0;
  return Math.max(0, failures - timeouts);
}

export function stageFlagCounts(metrics: any, pins: ServedPins = {}): StageFlagCounts {
  const out: StageFlagCounts = { max_tokens: 0, parse_failure: 0, stage_timeout: 0, stage_error: 0, served_model_mismatch: 0 };
  const stages = metrics?.stages ?? {};
  for (const src of SOURCES) {
    for (const s of Object.values<any>(stages[src] ?? {})) {
      out.max_tokens += s.maxTokens ?? 0;
      out.parse_failure += s.parseFailures ?? 0;
      out.stage_timeout += s.timeouts ?? 0;
      out.stage_error += stageApiErrors(s);
      out.served_model_mismatch += stageServedMismatches(s, pins);
    }
  }
  return out;
}

export function classifyFailure(error: unknown): AttemptOutcome {
  const msg = String((error as any)?.message ?? error ?? '');
  return /timeout|timed out|etimedout|deadline|aborted|AbortError/i.test(msg) ? 'timeout' : 'error';
}

// 'success' means complete AND no stage flag. When several flags are present the most
// model-attributable wins: a served-model mismatch means the arm didn't measure the model it
// claims; then truncation, parse failure, stage timeout.
export function classifyCompleteAttempt(metrics: any, pins: ServedPins = {}): { outcome: AttemptOutcome; flags: string[] } {
  const c = stageFlagCounts(metrics, pins);
  const flags = (Object.keys(c) as Array<keyof StageFlagCounts>).filter(k => c[k] > 0);
  const order: AttemptOutcome[] = ['served_model_mismatch', 'stage_error', 'max_tokens', 'parse_failure', 'stage_timeout'];
  const outcome = order.find(o => flags.includes(o as keyof StageFlagCounts)) ?? 'success';
  return { outcome, flags };
}

// ---- cost from stage summaries -------------------------------------------------------------

export interface CostResult {
  usd: number;                   // sum over PRICED stages only
  unknownStages: string[];       // stages whose model has no price row — NOT included in usd
  thinkingTokens: number;
  // Upper bound if thought tokens are billed ON TOP of candidatesTokenCount (see the "thinking
  // tokens" note in docs/eval/model-upgrade-test-plan.md). Not a measurement.
  thinkingExtraUsd: number;
}

export function costOfMetrics(metrics: any, at: Date): CostResult {
  const res: CostResult = { usd: 0, unknownStages: [], thinkingTokens: 0, thinkingExtraUsd: 0 };
  const stages = metrics?.stages ?? {};
  for (const src of SOURCES) {
    for (const [stage, s] of Object.entries<any>(stages[src] ?? {})) {
      const models = Object.keys(s.requestedModels ?? {});
      res.thinkingTokens += s.thinkingTokens ?? 0;
      if (models.length !== 1 || !isModelPriced(models[0])) {
        res.unknownStages.push(`${src}.${stage}`);
        continue;
      }
      res.usd += computeCostUsd(models[0], s.inputTokens ?? 0, s.outputTokens ?? 0, 0, { at });
      res.thinkingExtraUsd += computeCostUsd(models[0], 0, s.thinkingTokens ?? 0, 0, { at });
    }
  }
  return res;
}
