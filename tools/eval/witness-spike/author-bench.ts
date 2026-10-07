// Measures how often a "proven" verdict is right when a real Gemini model
// writes the witness. For each finding it builds the author's input bundle,
// asks the model for a witness (n samples), runs each through the same
// validate/sandbox/decide pipeline the testbed uses, and scores the verdict
// against author-truth.json.
//
//   ts-node witness-spike/author-bench.ts --prompt v1|v2 [--n 3] [--set all|testbed|spike|heldout]
//                                          [--bundle single|whole]
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
import { listCases, CASES_DIR, HELDOUT_DIR } from './testbed';
import { bundleFor, entries, worktree } from './run';

const HERE = __dirname;
type TruthFile = { cases: Record<string, Truth & { why: string }> };
const readTruth = (f: string): TruthFile => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));
// Both files together: ids never overlap (the held-out cases have their own ids), so one lookup serves every set.
const TRUTH: TruthFile = { cases: { ...readTruth('author-truth.json').cases, ...readTruth('heldout-truth.json').cases } };
const OUT_DIR = path.join(HERE, '..', 'fixtures', 'witness-author-runs');

/** Output that Jest would run unsandboxed: refuse anything reaching outside the process's own data. */
export function jestGuard(source: string): string | null {
  // Modules a witness has no business loading. `os` is allowed on purpose: the prompt lets a
  // witness write under fs.mkdtempSync(os.tmpdir()).
  const mod = '(?:node:)?(?:net|http|https|http2|dgram|dns|tls|vm|fs\\/promises|child_process)';
  const q = '[\'"`]';
  const banned = new RegExp([
    'child_process', '\\bworker_threads\\b', '\\bcluster\\b',
    `\\brequire\\s*\\(\\s*${q}${mod}${q}`,      // require ('net'), require\n('net')
    `\\bfrom\\s+${q}${mod}${q}`,                  // import { x } from 'net'
    `\\bimport\\s+${q}${mod}${q}`,                // import 'net'
    'process\\.(?:env|exit|kill|binding|chdir)', '\\bfetch\\s*\\(', '\\beval\\s*\\(', 'new\\s+Function\\b',
    '\\bimport\\s*\\(', 'XMLHttpRequest', 'WebSocket',
  ].join('|'));
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
  set: 'testbed' | 'spike' | 'heldout';
  language: 'go' | 'javascript';
  headDir: string;
  baseDir: string | null;
  timeoutMs?: number;
  bundle(whole: boolean): string;
}

function testbedFindings(casesDir: string = CASES_DIR, setName: 'testbed' | 'heldout' = 'testbed'): Finding[] {
  return listCases(casesDir).map((c) => {
    const dir = path.join(casesDir, c.id);
    const head = path.join(dir, 'head');
    const base = fs.existsSync(path.join(dir, 'base')) ? path.join(dir, 'base') : null;
    const rel = c.finding.file;
    const pkg = path.posix.dirname(rel);
    return {
      id: c.id, file: rel, set: setName, language: c.language, headDir: head, baseDir: base, timeoutMs: c.timeoutMs,
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
  // A flag with no value after it (e.g. a trailing `--n`) falls back to the default instead of undefined.
  const arg = (k: string, d?: string) => {
    const i = argv.indexOf(k);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
  };
  const version = arg('--prompt', 'v1') as string;
  const n = Number(arg('--n', '3'));
  const set = arg('--set', 'all') as string;
  const only = arg('--only');
  // The bundle defaults to the prompt's own (v1 = one file, v2 = whole package); --bundle overrides it, so the
  // prompt rule and the bundle content can be varied independently (bundle-only and rule-only arms).
  const bundleMode = arg('--bundle', version === 'v1' ? 'single' : 'whole') as string;
  if (bundleMode !== 'single' && bundleMode !== 'whole') throw new Error('--bundle must be single or whole');
  const whole = bundleMode === 'whole';
  const systemPrompt = loadPrompt(version);

  if (!['all', 'testbed', 'spike', 'heldout'].includes(set)) throw new Error('--set must be all, testbed, spike or heldout');
  // 'all' is the original in-sample set (testbed + spike). The held-out cases are only ever selected by name.
  let findings = set === 'heldout'
    ? testbedFindings(HELDOUT_DIR, 'heldout')
    : [...(set === 'spike' ? [] : testbedFindings()), ...(set === 'testbed' ? [] : spikeFindings())];
  if (only) findings = findings.filter((f) => f.id === only);
  if (!findings.length) throw new Error('no findings selected');
  for (const f of findings) if (!TRUTH.cases[f.id]) throw new Error(`no ground truth for ${f.id}`);

  const image = process.env.WITNESS_IMAGE || 'witness-go:1.24';
  // Everything Go-specific (Docker, the module cache, the build cache) is skipped for a JavaScript-only
  // selection, so such a run works on a host with no Go toolchain.
  const hasGo = findings.some((f) => f.language === 'go');
  // A dead daemon makes every Go run come back `not_run`, which scores as an
  // inconclusive verdict and would silently corrupt the measurement. Fail loudly instead.
  if (hasGo) {
    try { execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }); }
    catch { throw new Error(`Docker is not reachable or image ${image} is missing; start dockerd and run build-go-image.sh`); }
  }
  // Default cache: a private 0700 directory (mkdtemp, so unpredictable and not a pre-planted symlink)
  // holding a 0777 child the container's non-root user can write. Other local users cannot traverse the
  // parent. A user-supplied GO_BUILD_CACHE is used as given and never chmod'ed: it must already be
  // writable by the sandbox user, because this script will not loosen permissions on a directory it did not create.
  const tempCache = hasGo && !process.env.GO_BUILD_CACHE;
  const cacheRoot = tempCache ? fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-witness-author-gocache-')) : '';
  const baseCfg: SandboxConfig = {
    image,
    goModCacheDir: process.env.GO_MOD_CACHE || (hasGo ? execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim() : ''),
    goBuildCacheDir: tempCache ? path.join(cacheRoot, 'cache') : (process.env.GO_BUILD_CACHE ?? ''),
    timeoutMs: 120000, memory: '2g', cpus: '2',
  };
  if (hasGo) fs.mkdirSync(baseCfg.goBuildCacheDir, { recursive: true });
  if (tempCache) fs.chmodSync(baseCfg.goBuildCacheDir, 0o777);
  const jest = { jestBin: path.join(HERE, '..', 'node_modules', '.bin', 'jest') };

  const jobs = findings.flatMap((f) => Array.from({ length: n }, (_, rep) => ({ f, rep })));
  const samples: Sample[] = [];
  console.log(`prompt ${version}, bundle ${bundleMode}, model ${AUTHOR_MODEL}, ${findings.length} findings x ${n} samples = ${jobs.length} author calls`);

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
      const guard = bindingError(f, out) ?? (out.claim.testable && out.witness && out.witness.language !== 'go' ? jestGuard(out.witness.source) : null);
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
  const outFile = arg('--out') ?? path.join(OUT_DIR, `author-${version}-${bundleMode}-${set}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ prompt: version, bundle: bundleMode, model: AUTHOR_MODEL, n, set, findings: findings.map((f) => f.id), summary, samples }, null, 2));
  console.log(`wrote ${outFile}`);
  // The default cache is per-run and about 300 MB, so remove it. Best effort: a non-root user may not
  // own the container-written files, in which case say so instead of failing a finished run.
  if (tempCache) {
    try { fs.rmSync(cacheRoot, { recursive: true, force: true }); }
    catch (e) { console.warn(`could not remove ${cacheRoot}: ${(e as Error).message}`); }
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
