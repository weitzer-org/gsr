// Multi-arm comparison runner: N local backends from ONE checkout, each with its own env overlay
// (tools/eval/arms/*.json), reviewing the same PRs at the same moment, so the model (or one
// setting) is the only thing that differs between arms. Writes a batch directory that report.ts
// and judge-batch.ts consume. See docs/eval/model-upgrade-test-plan.md.
//
//   npx ts-node compare-arms.ts --arms arms/model-upgrade.json --prs-file fixtures/model-upgrade-prs.json
//       dry run (default): prints the plan and the call arithmetic, spends nothing
//   ... --live --max-review-calls 120 [--limit-prs 1] [--reps 1] [--out dir] [--resume dir]
//       live: builds and starts the backends, runs the matrix
//
// Scheduling: PRs run one after another; within each (PR, repetition) every arm runs AT THE SAME
// TIME, so all arms see the same API load at the same moment. Arm start order is shuffled per
// (PR, rep) from the batch seed and recorded in the manifest.
//
// Retries: an attempt that does not return a complete review is retried up to --max-attempts;
// EVERY attempt is saved with its outcome. A complete review is accepted as-is, even if a stage
// hit MAX_TOKENS / a timeout / a parse failure (those are flagged and counted, not retried away).
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import 'dotenv/config';
import { runReview, CombinedResult } from './api-client';
import {
  ArmConfig, loadArms, assertExplicitRouting, assertParity, buildBackendEnv, resolveArmRouting, diffRoutingAgainstStatus,
} from './arms';
import {
  Manifest, ManifestArm, ManifestPr, RunRecord, Attempt, newBatchId, prSlug, runFileName, sizeClassOf, writeJson, SCHEMA,
  classifyCompleteAttempt, classifyFailure, ServedPins, loadBatch,
} from './batch';
import { CallBudget, BudgetExceededError, requireCap } from './budget';
import { makeRng, shuffled } from './stats';
import { startNullS3 } from './nullS3';

export function hashSeed(seed: number, ...parts: string[]): number {
  let h = 2166136261 ^ seed;
  for (const ch of parts.join('\u0000')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The order arms are started in for one (PR, rep): shuffled, deterministic from the seed.
export function planStartOrder(armNames: readonly string[], slug: string, rep: number, seed: number): string[] {
  return shuffled(armNames, makeRng(hashSeed(seed, slug, String(rep))));
}

export interface RetryDeps {
  runReview: (baseUrl: string, prUrl: string, pat: string, opts: { timeoutMs?: number }) => Promise<CombinedResult>;
  now: () => number;
  budget: CallBudget;
  pins: ServedPins;
  inFlight: { n: number };    // shared counter of attempts currently running, for the load context
}

export interface AttemptLoopResult {
  attempts: Attempt[];
  result: CombinedResult | null;
  acceptedAttempt: number | null;
}

// One (arm, PR, rep): attempt until a complete review comes back or attempts run out.
export async function runWithRetries(
  args: { baseUrl: string; prUrl: string; pat: string; maxAttempts: number; timeoutMs: number; plannedConcurrency?: number },
  deps: RetryDeps
): Promise<AttemptLoopResult> {
  const attempts: Attempt[] = [];
  for (let n = 1; n <= args.maxAttempts; n++) {
    deps.budget.take(); // throws BudgetExceededError: the batch stops, it does not record a fake failure
    const startedAt = new Date(deps.now()).toISOString();
    const t0 = deps.now();
    deps.inFlight.n++;
    // First attempts of a group start within milliseconds of each other, so counting what is already
    // in flight would record start ORDER (1..N), not load. The planned group size is the load.
    const concurrent = n === 1 && args.plannedConcurrency ? args.plannedConcurrency : deps.inFlight.n;
    try {
      const res = await deps.runReview(args.baseUrl, args.prUrl, args.pat, { timeoutMs: args.timeoutMs });
      const cls = classifyCompleteAttempt(res.metrics, deps.pins);
      attempts.push({ n, started_at: startedAt, duration_ms: deps.now() - t0, complete: true, outcome: cls.outcome, flags: cls.flags, concurrent_arms: concurrent });
      return { attempts, result: res, acceptedAttempt: n };
    } catch (e: any) {
      if (e instanceof BudgetExceededError) throw e;
      attempts.push({ n, started_at: startedAt, duration_ms: deps.now() - t0, complete: false, outcome: classifyFailure(e), flags: [], error: String(e?.message ?? e).slice(0, 500), concurrent_arms: concurrent });
    } finally {
      deps.inFlight.n--;
    }
  }
  return { attempts, result: null, acceptedAttempt: null };
}

export function buildRunRecord(batchId: string, arm: string, prUrl: string, rep: number, loop: AttemptLoopResult): RunRecord {
  const first = loop.attempts[0];
  return {
    schema: SCHEMA, batch_id: batchId, arm, pr: prUrl, pr_slug: prSlug(prUrl), rep,
    attempts: loop.attempts,
    first_attempt_complete: !!first?.complete,
    first_attempt_clean: !!first && first.outcome === 'success',
    retries: Math.max(0, loop.attempts.length - 1),
    accepted_attempt: loop.acceptedAttempt,
    result: loop.result ? { findings: loop.result.findings, metrics: loop.result.metrics, evaluation: loop.result.evaluation } : null,
  };
}

// ---- plan arithmetic ----------------------------------------------------------------------------

export interface Plan { prs: number; reps: number; arms: number; reviews: number; worstCaseAttempts: number }

export function planCalls(prs: number, reps: number, arms: number, maxAttempts: number): Plan {
  const reviews = prs * reps * arms;
  return { prs, reps, arms, reviews, worstCaseAttempts: reviews * maxAttempts };
}

// ---- CLI ------------------------------------------------------------------------------------------

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}
const flag = (name: string) => process.argv.includes(name);

function gitInfo(): Manifest['git'] {
  const run = (c: string) => { try { return execSync(c, { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  return { commit: run('git rev-parse HEAD'), branch: run('git rev-parse --abbrev-ref HEAD'), dirty: run('git status --porcelain').length > 0 };
}

function collectPrs(): { url: string; group: string }[] {
  const list: { url: string; group: string }[] = [];
  const add = (urls: string[], group: string) => { for (const u of urls) if (!list.some(x => x.url === u)) list.push({ url: u, group }); };
  const file = arg('--prs-file');
  if (file) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j)) add(j, 'prs-file');
    else {
      add(j.sample_prs ?? [], 'config');
      add(j.large_set ?? [], 'large_set');
    }
  } else {
    add(JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).sample_prs ?? [], 'config');
  }
  for (let i = 0; i < process.argv.length; i++) if (process.argv[i] === '--pr') add([process.argv[i + 1]], 'cli');
  const only = arg('--only-pr');
  const filtered = only ? list.filter(p => p.url.includes(only)) : list;
  const limit = arg('--limit-prs');
  return limit ? filtered.slice(0, Number(limit)) : filtered;
}

async function waitForStatus(baseUrl: string, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e: any) { last = e.message; }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`backend at ${baseUrl} did not become ready (${last})`);
}

async function accessible(prUrl: string, token: string): Promise<{ ok: boolean; reason?: string }> {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return { ok: false, reason: 'not a PR URL' };
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  return res.ok ? { ok: true } : { ok: false, reason: `GitHub API returned ${res.status}` };
}

async function main() {
  const armsFile = arg('--arms');
  if (!armsFile) throw new Error('--arms <file> is required');
  const arms = loadArms(armsFile);
  assertExplicitRouting(arms);
  assertParity(arms);

  const reps = Number(arg('--reps', '2'));
  const seed = Number(arg('--seed', String(Date.now() % 2147483647)));
  const maxAttempts = Number(arg('--max-attempts', '3'));
  const timeoutMs = Number(arg('--attempt-timeout-ms', String(15 * 60 * 1000)));
  const basePort = Number(arg('--base-port', '8101'));
  const live = flag('--live');
  const prs = collectPrs();
  const plan = planCalls(prs.length, reps, arms.length, maxAttempts);

  console.log(`Arms: ${arms.map(a => a.name).join(', ')}`);
  console.log(`PRs: ${plan.prs}, repetitions: ${plan.reps}, reviews (PR x rep x arm): ${plan.reviews}, worst case with ${maxAttempts} attempts each: ${plan.worstCaseAttempts}`);
  for (const a of arms) console.log(`  ${a.name}: ${JSON.stringify(resolveArmRouting(a, process.env).stageModels)} thinking=${resolveArmRouting(a, process.env).thinkingLevel ?? 'default'}`);
  if (!live) {
    console.log('\nDRY RUN: nothing was started and nothing was spent. Add --live --max-review-calls N to run.');
    return;
  }

  const cap = requireCap('EVAL_MAX_REVIEW_CALLS / --max-review-calls', arg('--max-review-calls', process.env.EVAL_MAX_REVIEW_CALLS));
  if (cap < plan.reviews) throw new Error(`The review-call cap (${cap}) is below the ${plan.reviews} first attempts this plan needs; raise it or shrink the plan.`);
  const budget = new CallBudget('review calls', cap);

  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && process.env.NODE_USE_ENV_PROXY !== '1') {
    console.warn('⚠️  HTTPS_PROXY is set but NODE_USE_ENV_PROXY=1 is not: Node\'s built-in fetch ignores the proxy, so the harness and the backends it starts may fail or bypass it. Re-run with NODE_USE_ENV_PROXY=1.');
  }
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_TOKEN (or GITHUB_PAT) is required.');
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required.');

  // Resume or fresh batch.
  const resumeDir = arg('--resume');
  let outDir: string;
  let batchId: string;
  let resumed: Manifest | undefined;
  if (resumeDir) {
    resumed = loadBatch(resumeDir).manifest;
    outDir = resumeDir;
    batchId = resumed.batch_id;
  } else {
    batchId = newBatchId();
    outDir = arg('--out') ?? path.resolve(__dirname, 'eval_results', 'model_upgrade', batchId);
  }
  fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true });

  // Preflight: exclude PRs this token cannot read, and say so.
  const excluded: Manifest['excluded_prs'] = [];
  const usable: { url: string; group: string }[] = [];
  for (const p of prs) {
    const a = await accessible(p.url, token);
    if (a.ok) usable.push(p); else excluded.push({ url: p.url, reason: a.reason ?? 'inaccessible' });
  }
  if (excluded.length) console.warn(`Excluded ${excluded.length} PR(s) this token cannot read:\n${excluded.map(e => `  ${e.url}: ${e.reason}`).join('\n')}`);
  if (usable.length === 0) throw new Error('No readable PRs.');

  // Build once, then start one backend per arm from the same dist/.
  const backendDir = path.resolve(__dirname, '../../adk/backend');
  console.log('Building adk/backend (tsc)...');
  execSync('npx tsc', { cwd: backendDir, stdio: 'inherit' });

  // Storage sink: backends write their per-call usage records here (kept per arm on disk) instead of
  // into whatever bucket the shell is configured for.
  const sink = await startNullS3({ saveDir: path.join(outDir, 'usage_records') });
  const children: ChildProcess[] = [];
  const cleanup = () => { for (const c of children) if (!c.killed) c.kill('SIGTERM'); void sink.close(); };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const manifestArms: ManifestArm[] = [];
  try {
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const port = basePort + i;
      const logFd = fs.openSync(path.join(outDir, 'logs', `${a.name}.log`), 'a');
      const child = spawn('node', ['dist/src/index.js'], { cwd: backendDir, env: buildBackendEnv(process.env, a, port, sink.endpoint), stdio: ['ignore', logFd, logFd] });
      children.push(child);
      const baseUrl = `http://localhost:${port}`;
      const status = await waitForStatus(baseUrl);
      const routing = resolveArmRouting(a, process.env);
      const problems = diffRoutingAgainstStatus(routing, status);
      if (problems.length) throw new Error(`Arm ${a.name} is not running the configuration it was given:\n  ${problems.join('\n  ')}`);
      // Record only the non-secret fields of the status.
      manifestArms.push({ ...a, port, routing, status_snapshot: { model: status.model, stageModels: status.stageModels, maxOutputTokens: status.maxOutputTokens, thinkingLevel: status.thinkingLevel, contextCaching: status.contextCaching } });
      console.log(`✅ ${a.name} up on :${port} — ${Object.values<string>(routing.stageModels).join('/')}`);
    }

    // Diffs, once per PR, saved so the report is reproducible offline.
    // Lazy: the backend's GitHub client pulls in an ESM-only Octokit that the jest transform cannot load.
    const { GitHubClient } = await import('../../adk/backend/src/github');
    const gh = new GitHubClient(token);
    const manifestPrs: ManifestPr[] = [];
    for (const p of usable) {
      const slug = prSlug(p.url);
      const diffFile = path.join(outDir, 'diffs', `${slug}.json`);
      let chunks;
      if (fs.existsSync(diffFile)) chunks = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
      else { chunks = await gh.getPRDiff(p.url); writeJson(diffFile, chunks); }
      manifestPrs.push({ url: p.url, slug, changed_files: chunks.length, size_class: sizeClassOf(chunks.length), group: p.group });
    }

    const startOrder: Record<string, string[]> = { ...(resumed?.start_order ?? {}) };
    const manifest: Manifest = resumed ?? {
      schema: SCHEMA, batch_id: batchId, created_at: new Date().toISOString(), git: gitInfo(),
      environment: { node: process.version, platform: process.platform, execution_mode: 'local-multi-backend', hostname_redacted: true },
      concurrency: { arms_in_flight: arms.length, per_backend: 'each backend runs 2 orchestrators (swarm + basic), each with a pool of 5 concurrent Gemini calls', note: 'all arms review the same PR/rep simultaneously; retries run under lighter load (recorded per attempt)' },
      arms: manifestArms, baseline_arm: arms.find(a => a.role === 'baseline')!.name, control_arm: arms.find(a => a.role === 'control')?.name,
      prs: manifestPrs, excluded_prs: excluded, reps, seed, start_order: startOrder, max_attempts: maxAttempts, attempt_timeout_ms: timeoutMs, max_review_calls: cap,
      settings: { GEMINI_TIMEOUT_MS: process.env.GEMINI_TIMEOUT_MS ?? 'default 300000', EVAL_REPS: String(reps) },
    };
    writeJson(path.join(outDir, 'manifest.json'), manifest);

    const deps: RetryDeps = { runReview, now: Date.now, budget, pins: {}, inFlight: { n: 0 } };
    for (const pr of manifestPrs) {
      for (let rep = 1; rep <= reps; rep++) {
        const order = planStartOrder(arms.map(a => a.name), pr.slug, rep, manifest.seed);
        manifest.start_order[`${pr.slug}#${rep}`] = order;
        const todo = order.filter(name => !fs.existsSync(path.join(outDir, 'runs', runFileName(pr.slug, rep, name))));
        if (!todo.length) continue;
        console.log(`\n=== ${pr.url} rep ${rep} (${pr.size_class}, ${pr.changed_files} files) — ${todo.join(', ')} ===`);
        await Promise.all(todo.map(async name => {
          const mArm = manifestArms.find(a => a.name === name)!;
          const loop = await runWithRetries({ baseUrl: `http://localhost:${mArm.port}`, prUrl: pr.url, pat: token, maxAttempts, timeoutMs, plannedConcurrency: todo.length }, deps);
          const rec = buildRunRecord(batchId, name, pr.url, rep, loop);
          writeJson(path.join(outDir, 'runs', runFileName(pr.slug, rep, name)), rec);
          console.log(`  ${name}: ${loop.result ? `${loop.result.findings.length} findings` : 'NO RESULT'} after ${loop.attempts.length} attempt(s) [${loop.attempts.map(a => a.outcome).join(', ')}]`);
        }));
        writeJson(path.join(outDir, 'manifest.json'), manifest);
      }
    }
    manifest.finished_at = new Date().toISOString();
    writeJson(path.join(outDir, 'manifest.json'), manifest);
    console.log(`\nDone. ${budget.callsUsed} review call(s) used of ${cap}. Batch: ${outDir}`);
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main().catch(err => { console.error('\n💥', err.message ?? err); process.exitCode = 1; });
}
