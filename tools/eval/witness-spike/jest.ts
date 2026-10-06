// Jest side of the witness runner. UNSANDBOXED: it runs the witness with the
// local jest binary, so it is only safe for trusted code (the testbed's own
// fixtures). A containerized Jest runner is Phase 1 work; until then the
// pipeline refuses to run Jest witnesses outside the testbed.

import { spawn } from 'child_process';
import * as path from 'path';
import type { SandboxRunResult } from '../../../adk/backend/src/witness/types';
import { JEST_WITNESS_TEST_NAME } from '../../../adk/backend/src/witness/types';
import { TailBuffer } from './sandbox';

const OUTPUT_TAIL_CHARS = 4096;

interface JestAssertion { title?: string; status?: string }
interface JestSuite { status?: string; message?: string; assertionResults?: JestAssertion[] }
interface JestJson { numRuntimeErrorTestSuites?: number; testResults?: JestSuite[] }

/** Reduces `jest --json` output to the SandboxRunResult flags. Exported for tests. */
export function parseJestJson(
  stdout: string,
  opts: { timedOut: boolean; exitCode: number | null },
): SandboxRunResult {
  let json: JestJson | undefined;
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { json = JSON.parse(stdout.slice(start, end + 1)); } catch { /* handled below */ }
  }

  const tailSource = json
    ? (json.testResults ?? []).map((s) => s.message ?? '').join('\n')
    : stdout;
  const outputTail = tailSource.length > OUTPUT_TAIL_CHARS ? tailSource.slice(-OUTPUT_TAIL_CHARS) : tailSource;

  if (!json) {
    return { exitCode: opts.exitCode, timedOut: opts.timedOut, buildFailed: false, witnessOutcome: 'not_run', outputTail };
  }

  const buildFailed = (json.numRuntimeErrorTestSuites ?? 0) > 0;
  const witnesses = (json.testResults ?? [])
    .flatMap((s) => s.assertionResults ?? [])
    .filter((a) => a.title === JEST_WITNESS_TEST_NAME);

  let witnessOutcome: SandboxRunResult['witnessOutcome'] = 'not_run';
  if (!opts.timedOut && !buildFailed && witnesses.length === 1) {
    if (witnesses[0].status === 'passed') witnessOutcome = 'pass';
    else if (witnesses[0].status === 'failed') witnessOutcome = 'fail';
  }
  return { exitCode: opts.exitCode, timedOut: opts.timedOut, buildFailed, witnessOutcome, outputTail };
}

/** Runs jest over a workspace copy that already contains the witness file. */
export function runJestWitnessNative(
  jestBin: string,
  workspace: string,
  witnessRelPath: string,
  timeoutMs: number,
): Promise<{ result: SandboxRunResult; wallMs: number }> {
  const started = Date.now();
  const args = [
    '--json', '--ci', '--rootDir', workspace, '--roots', workspace,
    // Exact path as a literal (not a glob, so `[id]` or `(group)` in a directory
    // name is safe), and not **/<basename>: another file with the same name
    // elsewhere in the checkout must not run and collapse the result to not_run.
    '--runTestsByPath', witnessRelPath,
  ];
  return new Promise((resolve) => {
    const child = spawn(jestBin, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: workspace } });
    const stdout = new TailBuffer();
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => stdout.push(d));
    // Drain stderr so a chatty child cannot block on a full pipe; Jest's --json
    // result goes to stdout, so stderr is discarded.
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ result: parseJestJson(stdout.toString(), { timedOut, exitCode: code }), wallMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ result: { exitCode: null, timedOut: false, buildFailed: false, witnessOutcome: 'not_run', outputTail: `jest spawn failed: ${err.message}` }, wallMs: Date.now() - started });
    });
  });
}
