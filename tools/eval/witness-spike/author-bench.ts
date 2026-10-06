// Measures how often a "proven" verdict is right when a real Gemini model
// writes the witness. For each finding it builds the author's input bundle,
// asks the model for a witness (n samples), runs each through the same
// validate/sandbox/decide pipeline the testbed uses, and scores the verdict
// against author-truth.json.
//
//   ts-node witness-spike/author-bench.ts --prompt v1|v2 [--n 3] [--set all|testbed|spike]
//                                          [--only <id>] [--out <file>]
//
// v1 = adk/prompts/witness/author.md with the Phase 0 bundle.
// v2 = author.v2.md with the bundle plus every source file of the package.
// Both prompts see the same findings, samples-per-finding and model, so their
// summaries share a denominator.
//
// Needs GEMINI_API_KEY, Docker and the witness-go image for Go cases, and a
// job_tracker clone (JOB_TRACKER_DIR) for the spike set. Jest witnesses run
// UNSANDBOXED with a scrubbed environment (see jest.ts), and the author's
// input there is only the repo's own trusted fixtures. A static deny-list
// (jestGuard) rejects obviously dangerous model output before it runs. The
// guard is a seatbelt for honest-but-wrong output, not a sandbox: do not run
// this on a shared host or point the Jest path at untrusted PRs.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WitnessAuthorOutput, WitnessVerdict } from '../../../adk/backend/src/witness/types';
import { authorWitness, AUTHOR_MODEL, loadPrompt, AuthorUsage } from './author';
import { buildBundle, readPackageFiles } from './bundle';
import { evaluateWitness } from './pipeline';
import { SandboxConfig } from './sandbox';
import { classify, Row, summarize, Truth } from './score';
import { listCases, CASES_DIR } from './testbed';
import { bundleFor, entries, worktree } from './run';

const HERE = __dirname;
const TRUTH: { cases: Record<string, Truth & { why: string }> } = JSON.parse(fs.readFileSync(path.join(HERE, 'author-truth.json'), 'utf8'));
const OUT_DIR = path.join(HERE, '..', 'fixtures', 'witness-author-runs');

/** Output that Jest would run unsandboxed: refuse anything reaching outside the process's own data. */
export function jestGuard(source: string): string | null {
  const banned = /child_process|\bworker_threads\b|\bcluster\b|require\(\s*['"`](?:node:)?(?:net|http|https|http2|dgram|dns|tls|vm|fs\/promises)['"`]|from\s+['"`](?:node:)?(?:net|http|https|http2|dgram|dns|tls|vm|child_process)['"`]|process\.(?:env|exit|kill|binding|chdir)|\bfetch\s*\(|\beval\s*\(|new\s+Function\b|\bimport\s*\(|XMLHttpRequest|WebSocket/;
  // `os` is allowed on purpose: the prompt lets a witness write under fs.mkdtempSync(os.tmpdir()).
  const m = banned.exec(source);
  return m ? `bench guard rejected witness: ${m[0]}` : null;
}

/**
 * A witness may only target the finding it was authored for. Without this, a
 * model reply for a Go finding could carry a matching JavaScript claim and
 * witness, which would reach the unsandboxed Jest runner. Returns a reason or null.
 */
export function bindingError(f: { file: string; language: 'go' | 'javascript' }, out: WitnessAuthorOutput): string | null {
  if (!out.claim.testable || !out.witness) return null;
  if (out.claim.file !== f.file) return `claim.file ${JSON.stringify(out.claim.file)} is not the finding's file ${JSON.stringify(f.file)}`;
  if (out.witness.language !== f.language) return `witness language ${out.witness.language} is not the finding's language ${f.language}`;
  return null;
}

function unifiedDiff(basePath: string | null, headPath: string, rel: string): string {
  try {
    return execFileSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, basePath ?? '/dev/null', headPath], { encoding: 'utf8' });
  } catch (e) {
    // diff exits 1 when the files differ, which is the normal case here.
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return err.stdout ?? '';
    throw e;
  }
}

interface Finding {
  id: string;
  /** Repo-relative file the finding is about; a witness must be for exactly this file. */
  file: string;
  set: 'testbed' | 'spike';
  language: 'go' | 'javascript';
  headDir: string;
  baseDir: string | null;
  timeoutMs?: number;
  bundle(whole: boolean): string;
}

function testbedFindings(): Finding[] {
  return listCases().map((c) => {
    const dir = path.join(CASES_DIR, c.id);
    const head = path.join(dir, 'head');
    const base = fs.existsSync(path.join(dir, 'base')) ? path.join(dir, 'base') : null;
    const rel = c.finding.file;
    const pkg = path.posix.dirname(rel);
    return {
      id: c.id, file: rel, set: 'testbed' as const, language: c.language, headDir: head, baseDir: base, timeoutMs: c.timeoutMs,
      bundle: (whole: boolean) => {
        const pkgDir = path.join(head, pkg);
        const listing = fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir).sort() : [];
        const nearby = listing.find((f) => /_test\.go$|\.test\.js$/.test(f));
        return buildBundle({
          // Only the finding's own fields: never case.json's notes or expectedVerdict, nor the reference witness.
          finding: { file: rel, line: c.finding.line, severity: c.finding.severity, summary: c.finding.summary, description: c.finding.summary },
          diff: unifiedDiff(base && fs.existsSync(path.join(base, rel)) ? path.join(base, rel) : null, path.join(head, rel), rel),
          fileUnderTest: fs.readFileSync(path.join(head, rel), 'utf8'),
          nearby: { path: nearby ? path.posix.join(pkg, nearby) : '', content: nearby ? fs.readFileSync(path.join(head, pkg, nearby), 'utf8') : '' },
          dirListing: listing,
          packageFiles: whole ? readPackageFiles(head, pkg, rel) : undefined,
        });
      },
    };
  });
}

function spikeFindings(): Finding[] {
  return entries.map((e) => {
    return {
      id: e.id, file: e.file, set: 'spike' as const, language: 'go' as const,
      headDir: worktree(e, 'head'), baseDir: worktree(e, 'base'),
      bundle: (whole: boolean) => bundleFor(e, whole),
    };
  });
}

/** Serializes sandbox runs so concurrent author calls cannot starve the timeout-sensitive runner. */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: limit }, async () => { for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t); }));
}

interface Sample {
  id: string; set: string; rep: number; prompt: string; truth: Truth;
  verdict: WitnessVerdict | null; outcome: string; note?: string; authorFailure?: string;
  claim?: WitnessAuthorOutput['claim']; witnessSource?: string;
  /** Per-run flags and the head output tail, so a hypothesis can be diagnosed afterwards. */
  runs?: Record<string, { outcome: string; buildFailed: boolean; timedOut: boolean; exitCode: number | null } | null>;
  headTail?: string;
  usage: AuthorUsage; costUsd: number; costUsdWithThinking: number;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string, d?: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const version = arg('--prompt', 'v1') as string;
  const n = Number(arg('--n', '3'));
  const set = arg('--set', 'all');
  const only = arg('--only');
  const whole = version !== 'v1';
  const systemPrompt = loadPrompt(version);

  let findings = [...(set === 'spike' ? [] : testbedFindings()), ...(set === 'testbed' ? [] : spikeFindings())];
  if (only) findings = findings.filter((f) => f.id === only);
  if (!findings.length) throw new Error('no findings selected');
  for (const f of findings) if (!TRUTH.cases[f.id]) throw new Error(`no ground truth for ${f.id}`);

  const baseCfg: SandboxConfig = {
    image: process.env.WITNESS_IMAGE || 'witness-go:1.24',
    goModCacheDir: process.env.GO_MOD_CACHE || execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim(),
    // A fresh unpredictable directory: a fixed /tmp path could be a pre-planted symlink that chmod follows.
    goBuildCacheDir: process.env.GO_BUILD_CACHE || fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-witness-author-gocache-')),
    timeoutMs: 120000, memory: '2g', cpus: '2',
  };
  fs.mkdirSync(baseCfg.goBuildCacheDir, { recursive: true });
  fs.chmodSync(baseCfg.goBuildCacheDir, 0o777);
  const jest = { jestBin: path.join(HERE, '..', 'node_modules', '.bin', 'jest') };

  const jobs = findings.flatMap((f) => Array.from({ length: n }, (_, rep) => ({ f, rep })));
  const samples: Sample[] = [];
  console.log(`prompt ${version}, model ${AUTHOR_MODEL}, ${findings.length} findings x ${n} samples = ${jobs.length} author calls`);

  await pool(jobs, 3, async ({ f, rep }) => {
    const truth: Truth = TRUTH.cases[f.id];
    const bundle = f.bundle(whole);
    const res = await authorWitness(bundle, { systemPrompt });
    let verdict: WitnessVerdict | null = null;
    let note: string | undefined;
    let runs: Sample['runs'];
    let headTail: string | undefined;
    if (res.output) {
      const out = res.output;
      const guard = bindingError(f, out) ?? (out.witness && out.witness.language !== 'go' ? jestGuard(out.witness.source) : null);
      if (guard) {
        verdict = 'hypothesis';
        note = guard;
      } else {
        const cfg = { ...baseCfg, timeoutMs: f.timeoutMs ?? baseCfg.timeoutMs };
        const ev = await exclusive(() => evaluateWitness(cfg, f.headDir, f.baseDir, out, jest));
        verdict = ev.verdict;
        note = ev.note;
        const flags = (r: typeof ev.runs extends infer R ? R extends { head1: infer T } ? T | null : never : never) =>
          r ? { outcome: r.witnessOutcome, buildFailed: r.buildFailed, timedOut: r.timedOut, exitCode: r.exitCode } : null;
        if (ev.runs) {
          runs = { head1: flags(ev.runs.head1), head2: flags(ev.runs.head2), base: flags(ev.runs.base) };
          headTail = ev.runs.head1.outputTail.slice(-500);
        }
      }
    }
    const outcome = classify(res.output ? verdict : null, truth);
    samples.push({
      id: f.id, set: f.set, rep, prompt: version, truth, verdict, outcome, note,
      authorFailure: res.output ? undefined : `${res.failure}: ${res.detail ?? ''}`,
      claim: res.output?.claim, witnessSource: res.output?.witness?.source, runs, headTail,
      usage: res.usage, costUsd: res.usage.costUsd, costUsdWithThinking: res.usage.costUsdWithThinking,
    });
    console.log(`${f.id.padEnd(46)} #${rep} ${String(verdict).padEnd(18)} ${outcome.padEnd(20)} $${res.usage.costUsd.toFixed(4)} ${note ?? res.failure ?? ''}`);
  });

  samples.sort((a, b) => a.id.localeCompare(b.id) || a.rep - b.rep);
  const rows: Row[] = samples.map((s) => ({ id: s.id, verdict: s.verdict, outcome: s.outcome as Row['outcome'], costUsd: s.costUsd, costUsdWithThinking: s.costUsdWithThinking }));
  const summary = summarize(rows);
  console.log('\n' + JSON.stringify(summary, null, 2));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = arg('--out') ?? path.join(OUT_DIR, `author-${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ prompt: version, model: AUTHOR_MODEL, n, set, findings: findings.map((f) => f.id), summary, samples }, null, 2));
  console.log(`wrote ${outFile}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
