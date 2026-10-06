// Phase 0 spike: runs one Go witness test inside the hardened container and
// reduces the result to a SandboxRunResult. Phase 1 moves the production
// version into adk/backend/src/witness/; this copy exists so the spike can
// measure yield and timings without committing to that API.
//
// Isolation (probed by tools/eval/witness-probe/run-probe.sh):
//   --network none, --read-only root, non-root, no capabilities, pid/memory/cpu
//   limits, no host environment inherited, workspace COPIED without .git (a
//   mounted checkout leaks the token that actions/checkout leaves in .git).
// Docker arguments are an array, never a shell string.
//
// Known limit for Phase 1: the Go build cache is mounted read-write so warm
// runs are fast (~1s vs ~47s cold). Code in the container can write to it, so
// a cache shared across untrusted PRs could be poisoned. Whether Go re-verifies
// cached output content on read is unverified here; until it is, use one cache
// per PR/run (or restore it read-only from a trusted build), never one shared
// across PRs.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SandboxRunResult } from '../../../adk/backend/src/witness/types';

export interface SandboxConfig {
  /** Image containing a Go toolchain at /usr/local/go. */
  image: string;
  /** Host directory holding a pre-populated Go module cache (mounted read-only). */
  goModCacheDir: string;
  /** Host directory for the Go build cache (mounted read-write; warm = fast). */
  goBuildCacheDir: string;
  timeoutMs: number;
  memory: string;
  cpus: string;
}

const OUTPUT_TAIL_CHARS = 4096;
const CAPTURE_MAX_BYTES = 2_000_000;

/**
 * Keeps roughly the last `max` bytes of a stream as a queue of Buffers, so a
 * witness that prints without bound costs O(output) rather than re-slicing a
 * multi-megabyte string on every chunk. Decoding happens once, at the end.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private head = 0; // chunks before this index are logically dropped
  private len = 0;
  constructor(private readonly max = CAPTURE_MAX_BYTES) {}
  push(d: Buffer | string): void {
    const b = typeof d === 'string' ? Buffer.from(d) : d;
    this.chunks.push(b);
    this.len += b.length;
    // Advance an index instead of Array.shift(): shift() is O(n) on a large
    // array (measured: 100k 64-byte chunks past a 2MB cap took 5.5s).
    while (this.chunks.length - this.head > 1 && this.len - this.chunks[this.head].length >= this.max) {
      this.len -= this.chunks[this.head++].length;
    }
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
  toString(): string {
    const s = Buffer.concat(this.chunks.slice(this.head)).toString('utf8');
    return s.length > this.max ? s.slice(-this.max) : s;
  }
}

/**
 * Copies `src` to a fresh world-writable temp dir, excluding .git and every
 * symlink. The checkout is attacker-controlled (a PR can commit a symlink to
 * any host path): copying a symlink and then chmod-ing or writing through it
 * would change permissions on, or write into, files outside the copy.
 * Dropping symlinks can only make a witness fail to build (inconclusive),
 * never turn a result into a false "proven".
 */
export function copyWorkspaceWithoutGit(src: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gsr-witness-ws-'));
  try {
    populateWorkspace(src, dest);
  } catch (err) {
    // The caller only learns `dest` from a successful return, so it must not leak here.
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

function populateWorkspace(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => path.basename(p) !== '.git' && !fs.lstatSync(p).isSymbolicLink(),
  });
  // The container runs as uid 65534, so the copy must be writable by it, which
  // makes it world-writable on the host while the run lasts (mkdtemp alone
  // would be 0700). Accepted for the spike, which runs on a developer machine
  // or a single-job ephemeral runner; Phase 1 must not run this on a shared
  // multi-user host (use per-run user namespaces or chown to the sandbox uid).
  // lstat, not stat: never follow a link out of the copy.
  const chmodAll = (p: string) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    // OR the bits in (never overwrite): a test may exec a repo script, so keep +x.
    // & 0o777 also drops setuid/setgid/sticky.
    fs.chmodSync(p, st.isDirectory() ? 0o777 : (st.mode & 0o777) | 0o666);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) chmodAll(path.join(p, e));
  };
  chmodAll(dest);
}

/**
 * Best-effort removal of a workspace copy. It must never throw: the sandboxed
 * code runs as uid 65534 and can create files and directories the host user is
 * not allowed to delete (reproduced: EACCES as a non-root host user), and a
 * throw from a `finally` would discard an already-finished run's result. A
 * leftover directory under the OS temp dir is the lesser cost (ephemeral
 * runners clean it up). Phase 1 must make removal reliable, e.g. with per-run
 * user namespaces or by running the container as the host uid.
 */
export function removeWorkspace(ws: string, rm: typeof fs.rmSync = fs.rmSync): void {
  try {
    rm(ws, { recursive: true, force: true });
  } catch (err) {
    console.warn(`could not fully remove witness workspace ${ws}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
}

/**
 * Writes the witness file into the workspace copy, refusing any target that
 * resolves outside it (defence in depth on top of dropping symlinks).
 */
export function writeWitnessFile(workspace: string, relPath: string, source: string): void {
  const root = fs.realpathSync(workspace);
  const target = path.join(root, relPath);
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error(`witness path escapes the workspace: ${relPath}`);
  }
  fs.writeFileSync(path.join(parent, path.basename(target)), source, { flag: 'wx' });
}

export function dockerArgs(cfg: SandboxConfig, name: string, workspace: string, goTestArgs: string[]): string[] {
  return [
    'run', '--rm', '--name', name,
    '--network', 'none',
    '--read-only',
    // exec is required: `go test` compiles the test binary into GOTMPDIR.
    '--tmpfs', '/tmp:rw,exec,size=1g',
    '--user', '65534:65534',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', cfg.memory,
    '--cpus', cfg.cpus,
    '-v', `${workspace}:/work:rw`,
    '-v', `${cfg.goModCacheDir}:/gomod:ro`,
    '-v', `${cfg.goBuildCacheDir}:/gocache:rw`,
    '-e', 'HOME=/tmp',
    '-e', 'GOCACHE=/gocache',
    '-e', 'GOPATH=/tmp/gopath',
    '-e', 'GOMODCACHE=/gomod',
    '-e', 'GOTOOLCHAIN=local',
    '-e', 'GOFLAGS=-mod=mod',
    '-e', 'GOPROXY=off',
    '-e', 'GOSUMDB=off',
    '-e', 'CGO_ENABLED=0',
    '-e', 'PATH=/usr/local/go/bin',
    '-w', '/work',
    cfg.image,
    'go', 'test', '-json', '-buildvcs=false', '-count=1', ...goTestArgs,
  ];
}

interface GoTestEvent {
  Action?: string;
  Test?: string;
  Output?: string;
  ImportPath?: string;
}

/** Reduces `go test -json` output to the SandboxRunResult flags. Exported for tests. */
export function parseGoTestJson(
  stdout: string,
  testName: string,
  opts: { timedOut: boolean; exitCode: number | null },
): SandboxRunResult {
  let witnessAction: 'pass' | 'fail' | 'skip' | undefined;
  let testRuns = 0;
  let buildFailed = false;
  let frameworkTimeout = false;
  const out: string[] = [];

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev: GoTestEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      out.push(line + '\n'); // non-JSON line (e.g. raw build error text); split() dropped its newline
      if (/\[(build|setup) failed\]/.test(line)) buildFailed = true;
      continue;
    }
    if (ev.Output) {
      out.push(ev.Output);
      // Output with a Test field was printed by the code under test, which the
      // PR author controls; the go tool's own build/setup failure lines are
      // package-level (no Test). Only the latter may set buildFailed.
      // The timeout panic is attributed to the running test even when genuine
      // (verified with go1.24.7), so it cannot be filtered this way; it stays
      // text-matched because a spoof there only downgrades the verdict to
      // inconclusive, whereas missing a real one would let a timed-out witness
      // read as `fail` and prove a claim.
      if (!ev.Test && /\[(build|setup) failed\]/.test(ev.Output)) buildFailed = true;
      if (/panic: test timed out/.test(ev.Output)) frameworkTimeout = true;
    }
    if (ev.Action === 'build-fail') buildFailed = true;
    if (ev.Test === testName) {
      if (ev.Action === 'run') testRuns++;
      if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') witnessAction = ev.Action;
    }
  }

  const timedOut = opts.timedOut || frameworkTimeout;
  let witnessOutcome: SandboxRunResult['witnessOutcome'] = 'not_run';
  if (!timedOut && !buildFailed && testRuns === 1) {
    // The JSON stream is not fully trustworthy: code under test can open
    // /proc/1/fd/1 and write forged events straight to the container's stdout
    // (reproduced in the sandbox). `go test` exits 0 iff the run passed, so the
    // event and the exit code must agree; a mismatch is inconclusive, never a
    // forged pass (which would read as `refuted`) or a forged fail.
    if (witnessAction === 'pass' && opts.exitCode === 0) witnessOutcome = 'pass';
    else if (witnessAction === 'fail' && opts.exitCode !== null && opts.exitCode !== 0) witnessOutcome = 'fail';
  }

  const text = out.join('');
  return {
    exitCode: opts.exitCode,
    timedOut,
    buildFailed,
    witnessOutcome,
    outputTail: text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text,
  };
}

export interface TimedRun {
  result: SandboxRunResult;
  wallMs: number;
}

/**
 * Runs the witness already written into `workspace` (a copy, not the checkout)
 * and kills the container if it exceeds cfg.timeoutMs.
 */
export function runGoWitness(
  cfg: SandboxConfig,
  workspace: string,
  packageDir: string,
  testName: string,
): Promise<TimedRun> {
  const name = `gsr-witness-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pkg = packageDir === '.' || packageDir === '' ? './' : `./${packageDir.replace(/^\.\//, '')}/`;
  const args = dockerArgs(cfg, name, workspace, ['-run', `^${testName}$`, pkg]);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    child.stderr.on('data', (d: Buffer) => stderr.push(d));

    const timer = setTimeout(() => {
      timedOut = true;
      // An unhandled 'error' (no docker binary/daemon) would crash the process.
      spawn('docker', ['kill', name], { stdio: 'ignore' }).on('error', () => {});
    }, cfg.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const err = stderr.toString();
      const result = parseGoTestJson(stdout.toString() + (err ? `\n${err}` : ''), testName, { timedOut, exitCode: code });
      resolve({ result, wallMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        result: { exitCode: null, timedOut: false, buildFailed: false, witnessOutcome: 'not_run', outputTail: `docker spawn failed: ${err.message}` },
        wallMs: Date.now() - started,
      });
    });
  });
}
