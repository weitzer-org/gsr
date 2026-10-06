import type { SandboxRunResult, VerdictInput, WitnessVerdict } from './types.js';

/** Outcome of a single sandboxed run, classified from SandboxRunResult.
 *  See the DECISION TABLE in types.ts (Step 1).
 */
export type RunOutcome = 'pass' | 'fail' | 'inconclusive';

/** Classify a single run result into pass/fail/inconclusive.
 *  Implements Step 1 of the decision table in types.ts.
 *  Never consults exitCode or outputTail.
 */
export function classifyRun(run: SandboxRunResult): RunOutcome {
  if (run.timedOut) {
    return 'inconclusive';
  }
  if (run.buildFailed) {
    return 'inconclusive';
  }
  if (run.witnessOutcome === 'not_run') {
    return 'inconclusive';
  }
  if (run.witnessOutcome === 'pass') {
    return 'pass';
  }
  return 'fail';
}

/** Compute the witness verdict from test runs.
 *  Implements Step 2 of the decision table in types.ts.
 *  Pure function: no I/O, no side effects.
 */
export function decideVerdict(input: VerdictInput): WitnessVerdict {
  // not_testable: only 'opinion' becomes 'opinion'; others become 'hypothesis'
  if (input.kind === 'not_testable') {
    if (input.notTestableKind === 'opinion') {
      return 'opinion';
    }
    return 'hypothesis';
  }

  // no_witness: always 'hypothesis'
  if (input.kind === 'no_witness') {
    return 'hypothesis';
  }

  // executed: classify each run and apply the decision logic
  if (input.kind === 'executed') {
    const h1 = classifyRun(input.headRun);
    const h2 = classifyRun(input.headRerun);

    // Any inconclusive result -> 'hypothesis'
    if (h1 === 'inconclusive' || h2 === 'inconclusive') {
      return 'hypothesis';
    }

    // Flaky witness (one pass, one fail) -> 'hypothesis'
    if (h1 !== h2) {
      return 'hypothesis';
    }

    // Both pass -> 'refuted'
    if (h1 === 'pass' && h2 === 'pass') {
      return 'refuted';
    }

    // Both fail: check base run to decide attribution
    // B is 'inconclusive' if baseRun is null or any inconclusive flag is set
    let base: RunOutcome;
    if (input.baseRun === null) {
      base = 'inconclusive';
    } else {
      base = classifyRun(input.baseRun);
    }

    if (base === 'fail') {
      return 'proven_preexisting';
    }
    // base === 'pass' or base === 'inconclusive' -> 'proven_regression'
    return 'proven_regression';
  }

  // TypeScript exhaustiveness check (should never reach here)
  const _exhaustive: never = input;
  return _exhaustive;
}
