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
// The author step is NOT automated here: this environment has no Gemini key,
// so authors are Claude subagents following adk/prompts/witness/author.md and
// the results are committed as fixtures. That is a validity caveat for the
// yield number, recorded in the Phase 0 report.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SandboxRunResult, WitnessAuthorOutput, WitnessVerdict } from '../../../adk/backend/src/witness/types';
import { decideVerdict } from '../../../adk/backend/src/witness/verdict';
import { SandboxConfig } from './sandbox';
import { evaluateWitness } from './pipeline';

interface FixtureEntry { id: string; prUrl: string; file: string; line: number; summary: string; gap?: string }
interface Cases { goDirectiveOverride?: string; prs: Record<string, { headSha: string; baseSha: string }> }

const HERE = __dirname;
const FIXTURE_PATH = path.join(HERE, '..', 'fixtures', 'job_tracker_regressions.json');
const WITNESS_DIR = path.join(HERE, '..', 'fixtures', 'witness-spike');
const JOB_TRACKER_DIR = process.env.JOB_TRACKER_DIR || '/home/user/job_tracker';
const WORK_DIR = process.env.WORK_DIR || '/tmp/gsr-witness-spike';

const cases: Cases = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
const entries: FixtureEntry[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).entries.must_catch;

const prNumber = (e: FixtureEntry) => e.prUrl.split('/').pop() as string;
const worktree = (e: FixtureEntry, side: 'head' | 'base') => path.join(WORK_DIR, `pr${prNumber(e)}-${side}`);

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

/** Stops untrusted text from closing one of the bundle's own tags early. */
export function tagSafe(text: string): string {
  return text.replace(/<\/(FINDING|DIFF|FILE_UNDER_TEST|NEARBY_TEST|DIR_LISTING)\b/gi, '<\\/$1');
}

function readOr(p: string, fallback = ''): string {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback;
}

function prepare() {
  fs.mkdirSync(path.join(WORK_DIR, 'author-inputs'), { recursive: true });
  for (const e of entries) {
    const pr = cases.prs[prNumber(e)];
    if (!pr) throw new Error(`No commits for PR ${prNumber(e)} in cases.json`);
    ensureWorktree(worktree(e, 'head'), pr.headSha);
    ensureWorktree(worktree(e, 'base'), pr.baseSha);

    const head = worktree(e, 'head');
    const dir = path.dirname(e.file);
    const diff = git(['diff', '--no-color', pr.baseSha, pr.headSha, '--', e.file]);
    const fileUnderTest = readOr(path.join(head, e.file));
    const nearby = fs.readdirSync(path.join(head, dir)).filter((f) => f.endsWith('_test.go')).sort()[0];
    const listing = fs.readdirSync(path.join(head, dir)).sort().join('\n');
    const finding = JSON.stringify({ file: e.file, line: e.line, severity: 'HIGH', summary: e.summary, description: e.summary }, null, 2);

    const bundle = [
      `<FINDING>\n${tagSafe(finding)}\n</FINDING>`,
      `<DIFF>\n${tagSafe(diff)}\n</DIFF>`,
      `<FILE_UNDER_TEST path="${e.file}">\n${tagSafe(fileUnderTest)}\n</FILE_UNDER_TEST>`,
      `<NEARBY_TEST path="${nearby ? path.join(dir, nearby) : ''}">\n${nearby ? tagSafe(readOr(path.join(head, dir, nearby))) : ''}\n</NEARBY_TEST>`,
      `<DIR_LISTING>\n${tagSafe(listing)}\n</DIR_LISTING>`,
    ].join('\n\n');
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
