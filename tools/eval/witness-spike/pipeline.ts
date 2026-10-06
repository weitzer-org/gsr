// Shared by the Phase 0 spike (run.ts) and the testbed (testbed.ts): validate
// an authored witness, then run it once in the sandbox.

import * as fs from 'fs';
import * as path from 'path';
import type { Claim, WitnessAuthorOutput } from '../../../adk/backend/src/witness/types';
import { GO_WITNESS_FILENAME, GO_WITNESS_TEST_NAME, JEST_WITNESS_SUFFIX, JEST_WITNESS_TEST_NAME } from '../../../adk/backend/src/witness/types';
import type { SandboxRunResult, VerdictInput, WitnessVerdict } from '../../../adk/backend/src/witness/types';
import { decideVerdict } from '../../../adk/backend/src/witness/verdict';
import { copyWorkspaceWithoutGit, runGoWitness, SandboxConfig, writeWitnessFile } from './sandbox';
import { runJestWitnessNative } from './jest';

/** Returns an error string if the witness may not be run, else null. */
export function validateWitness(claim: Claim, witness: NonNullable<WitnessAuthorOutput['witness']>, headDir: string): string | null {
  const dir = path.posix.dirname(claim.file);
  let expected: string;
  if (witness.language === 'go' && witness.framework === 'go-test') {
    expected = `${dir}/${GO_WITNESS_FILENAME}`;
    if (!new RegExp(`func ${GO_WITNESS_TEST_NAME}\\(t \\*testing\\.T\\)`).test(witness.source)) return `no func ${GO_WITNESS_TEST_NAME}`;
  } else if (witness.language === 'javascript' && witness.framework === 'jest') {
    expected = `${dir}/${path.posix.basename(claim.file, path.posix.extname(claim.file))}${JEST_WITNESS_SUFFIX}.js`;
    if (!new RegExp(`test\\(\\s*['"]${JEST_WITNESS_TEST_NAME}['"]`).test(witness.source)) return `no test('${JEST_WITNESS_TEST_NAME}', ...)`;
  } else {
    return `unsupported witness language/framework: ${witness.language}/${witness.framework}`;
  }
  if (witness.path !== expected) return `path ${JSON.stringify(witness.path)} is not the allowed ${JSON.stringify(expected)}`;
  if (witness.path.includes('..') || path.isAbsolute(witness.path)) return 'path escapes the repo';
  if (fs.existsSync(path.join(headDir, witness.path))) return 'witness path already exists in the checkout';
  return null;
}

/** Where the Jest binary lives; only the trusted testbed may use it (see jest.ts). */
export interface JestRunner { jestBin: string }

export async function runOnce(
  cfg: SandboxConfig,
  checkout: string,
  claim: Claim,
  witness: { path: string; source: string },
  jest?: JestRunner,
) {
  const ws = copyWorkspaceWithoutGit(checkout);
  try {
    writeWitnessFile(ws, witness.path, witness.source);
    if (claim.language === 'go') {
      return await runGoWitness(cfg, ws, path.posix.dirname(claim.file), GO_WITNESS_TEST_NAME);
    }
    if (!jest) throw new Error('Jest witnesses run unsandboxed; pass a JestRunner (testbed only)');
    return await runJestWitnessNative(jest.jestBin, ws, witness.path, cfg.timeoutMs);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

export interface EvaluationResult {
  verdict: WitnessVerdict;
  input: VerdictInput;
  note?: string;
  runs?: { head1: SandboxRunResult; head2: SandboxRunResult; base: SandboxRunResult | null };
  wallMs?: number[];
}

/**
 * The whole per-finding pipeline after authoring: validate, run twice on head,
 * once on base (when the file exists there), decide. `baseDir` null means the
 * PR has no base checkout at all.
 */
export async function evaluateWitness(
  cfg: SandboxConfig,
  headDir: string,
  baseDir: string | null,
  out: WitnessAuthorOutput,
  jest?: JestRunner,
): Promise<EvaluationResult> {
  if (!out.claim.testable || !out.witness) {
    const input: VerdictInput = { kind: 'not_testable', notTestableKind: out.claim.notTestableKind ?? 'insufficient_context' };
    return { verdict: decideVerdict(input), input };
  }
  const bad = validateWitness(out.claim, out.witness, headDir);
  if (bad) {
    const input: VerdictInput = { kind: 'no_witness' };
    return { verdict: decideVerdict(input), input, note: `rejected: ${bad}` };
  }
  const h1 = await runOnce(cfg, headDir, out.claim, out.witness, jest);
  const h2 = await runOnce(cfg, headDir, out.claim, out.witness, jest);
  const baseHasFile = baseDir !== null && fs.existsSync(path.join(baseDir, out.claim.file));
  const b = baseHasFile ? await runOnce(cfg, baseDir as string, out.claim, out.witness, jest) : null;
  const input: VerdictInput = { kind: 'executed', headRun: h1.result, headRerun: h2.result, baseRun: b ? b.result : null };
  return {
    verdict: decideVerdict(input),
    input,
    runs: { head1: h1.result, head2: h2.result, base: b ? b.result : null },
    wallMs: [h1.wallMs, h2.wallMs, ...(b ? [b.wallMs] : [])],
  };
}
