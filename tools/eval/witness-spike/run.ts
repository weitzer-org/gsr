// Phase 0 spike for "Prove It". Two commands:
//
//   ts-node witness-spike/run.ts prepare
//     Creates head/base git worktrees of weitzer-org/job_tracker for each
//     must_catch fixture entry and writes the witness author's input bundle
//     (<FINDING>/<DIFF>/<FILE_UNDER_TEST>/<NEARBY_TEST>/<DIR_LISTING>) for each.
//
//   ts-node witness-spike/run.ts run
//     For each entry, reads the author's output (fixtures/witness-spike/<id>.json,
//     a WitnessAuthorOutput), validates the witness path, runs it in the
//     sandbox twice on head and once on base, and prints the verdict and timings.
//
// Env: JOB_TRACKER_DIR (clone of weitzer-org/job_tracker, default
// /home/user/job_tracker), WORK_DIR (default /tmp/gsr-witness-spike),
// GO_MOD_CACHE (default $(go env GOMODCACHE)), GO_BUILD_CACHE (default
// $WORK_DIR/gocache), WITNESS_IMAGE (default witness-go:1.24),
// WITNESS_TIMEOUT_MS (default 120000).
//
// `run` reads fixtures/witness-spike/<id>.json, the Phase 0 witnesses written
// by Claude subagents. The automated Gemini author is author-bench.ts, which
// reuses this file's worktrees and bundle. WHOLE_PACKAGE=1 adds the package's
// source files to the bundle (prompt v2).

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SandboxRunResult, WitnessAuthorOutput, WitnessVerdict } from '../../../adk/backend/src/witness/types';
import { decideVerdict } from '../../../adk/backend/src/witness/verdict';
import { SandboxConfig } from './sandbox';
import { evaluateWitness } from './pipeline';
import { buildBundle, readPackageFiles, tagSafe } from './bundle';

export { tagSafe };

export interface FixtureEntry { id: string; prUrl: string; file: string; line: number; summary: string; gap?: string }
interface Cases { goDirectiveOverride?: string; prs: Record<string, { headSha: string; baseSha: string }> }

const HERE = __dirname;
const FIXTURE_PATH = path.join(HERE, '..', 'fixtures', 'job_tracker_regressions.json');
const WITNESS_DIR = path.join(HERE, '..', 'fixtures', 'witness-spike');
const JOB_TRACKER_DIR = process.env.JOB_TRACKER_DIR || '/home/user/job_tracker';
const WORK_DIR = process.env.WORK_DIR || '/tmp/gsr-witness-spike';

const cases: Cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
export const entries: FixtureEntry[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).entries.must_catch;

export const prNumber = (e: FixtureEntry) => e.prUrl.split('/').pop() as string;
export const worktree = (e: FixtureEntry, side: 'head' | 'base') => path.join(WORK_DIR, `pr${prNumber(e)}-${side}`);

function git(args: string[], cwd = JOB_TRACKER_DIR): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function ensureWorktree(dir: string, sha: string) {
  if (fs.existsSync(dir)) return;
  git(['worktree', 'add', '-q', '--detach', dir, sha]);
  const gomod = path.join(dir, 'go.mod');
  if (cases.goDirectiveOverride && fs.existsSync(gomod)) {
    // Spike-only: identical rewrite on head and base (see cases.json).
    fs.writeFileSync(gomod, fs.readFileSync(gomod, 'utf8').replace(/^go \d+\.\d+(\.\d+)?$/m, `go ${cases.goDirectiveOverride}`));
  }
}

function readOr(p: string, fallback = ''): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback;
}

/** Prepares the head/base worktrees for one entry and returns its author input bundle. */
export function bundleFor(e: FixtureEntry, wholePackage = false): string {
  const pr = cases.prs[prNumber(e)];
  if (!pr) throw new Error(`No commits for PR ${prNumber(e)} in cases.json`);
  ensureWorktree(worktree(e, 'head'), pr.headSha);
  ensureWorktree(worktree(e, 'base'), pr.baseSha);

  const head = worktree(e, 'head');
  const dir = path.posix.dirname(e.file);
  const diff = git(['diff', '--no-color', pr.baseSha, pr.headSha, '--', e.file]);
  const fileUnderTest = readOr(path.join(head, e.file));
  // The directory may not exist at head (the PR can delete the file's whole directory).
  const listing = fs.existsSync(path.join(head, dir)) ? fs.readdirSync(path.join(head, dir)).sort() : [];
  const nearby = listing.filter((f) => f.endsWith('_test.go'))[0];
  return buildBundle({
    finding: { file: e.file, line: e.line, severity: 'HIGH', summary: e.summary, description: e.summary },
    diff,
    fileUnderTest,
    nearby: { path: nearby ? path.posix.join(dir, nearby) : '', content: nearby ? readOr(path.join(head, dir, nearby)) : '' },
    dirListing: listing,
    packageFiles: wholePackage ? readPackageFiles(head, dir, e.file) : undefined,
  });
}

function prepare() {
  fs.mkdirSync(path.join(WORK_DIR, 'author-inputs'), { recursive: true });
  for (const e of entries) {
    const bundle = bundleFor(e, !!process.env.WHOLE_PACKAGE);
    fs.writeFileSync(path.join(WORK_DIR, 'author-inputs', `${e.id}.txt`), bundle);
    console.log(`prepared ${e.id} (bundle ${bundle.length} chars)`);
  }
}

async function run() {
  const cfg: SandboxConfig = {
    image: process.env.WITNESS_IMAGE || 'witness-go:1.24',
    goModCacheDir: process.env.GO_MOD_CACHE || execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim(),
    goBuildCacheDir: process.env.GO_BUILD_CACHE || path.join(WORK_DIR, 'gocache'),
    timeoutMs: Number(process.env.WITNESS_TIMEOUT_MS || 120000),
    memory: '2g',
    cpus: '2',
  };
  fs.mkdirSync(cfg.goBuildCacheDir, { recursive: true });
  fs.chmodSync(cfg.goBuildCacheDir, 0o777);

  const rows: Record<string, unknown>[] = [];
  for (const e of entries) {
    const row: Record<string, unknown> = { id: e.id, pr: prNumber(e) };
    const authored = path.join(WITNESS_DIR, `${e.id}.json`);
    let verdict: WitnessVerdict;

    if (!fs.existsSync(authored)) {
      row.note = 'no authored witness fixture';
      verdict = decideVerdict({ kind: 'no_witness' });
    } else {
      const out: WitnessAuthorOutput = JSON.parse(fs.readFileSync(authored, 'utf8'));
      row.claim = out.claim;
      const ev = await evaluateWitness(cfg, worktree(e, 'head'), worktree(e, 'base'), out);
      verdict = ev.verdict;
      if (ev.note) row.note = ev.note;
      if (ev.runs) {
        row.runs = {
          head1: summarize(ev.runs.head1, ev.wallMs![0]),
          head2: summarize(ev.runs.head2, ev.wallMs![1]),
          base: ev.runs.base ? summarize(ev.runs.base, ev.wallMs![2]) : 'null (file absent on base: new in this PR)',
        };
        row.headOutputTail = ev.runs.head1.outputTail.slice(-600);
      }
    }

    row.verdict = verdict;
    rows.push(row);
    console.log(`${e.id.padEnd(48)} ${verdict}`);
  }

  const outDir = path.join(HERE, '..', 'witness-spike-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `spike-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
  console.log(`\nwrote ${outFile}`);
}

function summarize(r: SandboxRunResult, wallMs: number) {
  return { outcome: r.witnessOutcome, buildFailed: r.buildFailed, timedOut: r.timedOut, exitCode: r.exitCode, wallMs };
}

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd === 'prepare' ? Promise.resolve(prepare()) : cmd === 'run' ? run() : Promise.reject(new Error('usage: run.ts prepare|run')))
    .catch((err) => { console.error(err); process.exit(1); });
}
