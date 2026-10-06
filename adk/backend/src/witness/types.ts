// "Prove It" witness types (Phase 0). Dependency-free on purpose: shared by
// the witness author (Gemini, prompt in adk/prompts/witness/author.md), the
// sandbox runner, and the pure verdict function.
//
// A *witness* is a single test that asserts the CORRECT behavior of the code a
// finding talks about, so it FAILS iff the finding's claim is true. It is run
// twice on the PR head (flake check) and once on the base commit. The verdict
// is computed by deterministic code from those runs — never by a model.
//
// ---------------------------------------------------------------------------
// DECISION TABLE  (VerdictInput -> WitnessVerdict), evaluated top to bottom,
// first matching row wins.
//
// Step 1 — classify each SandboxRunResult into an Outcome:
//   timedOut === true                        -> 'inconclusive'
//   buildFailed === true                     -> 'inconclusive'
//   witnessOutcome === 'not_run'             -> 'inconclusive'
//   witnessOutcome === 'pass'                -> 'pass'
//   witnessOutcome === 'fail'                -> 'fail'
//   (exitCode and outputTail are NEVER consulted by the verdict function.)
//
//   Only a witness that compiled, loaded, actually executed, and then failed
//   an assertion (or panicked/threw while calling the code under test) counts
//   as "fails". A compile error, syntax error, unresolved import, a top-level
//   "gsr-setup:" throw (Jest), a t.Skip (Go), zero tests collected, or a
//   timeout is NOT evidence that the claim is true — it is 'inconclusive'.
//
// Step 2 — decide:
//   kind 'not_testable', notTestableKind 'opinion'            -> 'opinion'
//   kind 'not_testable', any other notTestableKind            -> 'hypothesis'
//   kind 'no_witness'                                         -> 'hypothesis'
//   kind 'executed':
//     H1 = outcome(headRun), H2 = outcome(headRerun)
//     H1 or H2 is 'inconclusive'                              -> 'hypothesis'
//     H1 !== H2  (one pass, one fail: flaky witness)          -> 'hypothesis'
//     H1 === H2 === 'pass'                                    -> 'refuted'
//     H1 === H2 === 'fail', then B = baseRun === null
//                                      ? 'inconclusive' : outcome(baseRun):
//       B === 'fail'                                          -> 'proven_preexisting'
//       B === 'pass'                                          -> 'proven_regression'
//       B === 'inconclusive' (incl. baseRun === null)         -> 'proven_regression'
//
//   Rationale for the last row: the claim is already proven by the two head
//   failures; the base run only decides attribution. "Pre-existing" requires
//   positive evidence (the witness conclusively fails on base). A witness that
//   does not even build on base almost always means the code under test is
//   new or re-shaped in this PR, which is the "code is new in the PR" case.
//   'refuted' does not look at base at all (a passing head is the whole story,
//   even if base fails — that just means the PR fixed it).
// ---------------------------------------------------------------------------

/** Languages a witness can be written in. `.tsx`/`.jsx` count as typescript/javascript. */
export type WitnessLanguage = 'go' | 'javascript' | 'typescript';

/** Test framework the witness targets. Go -> 'go-test'; JS/TS -> 'jest'. */
export type WitnessFramework = 'go-test' | 'jest';

/**
 * Why a claim cannot be witnessed. The model picks the category; code maps
 * it to a verdict (see table): only 'opinion' becomes the 'opinion' verdict.
 *  - 'opinion': not a behavioral claim at all (style, naming, missing docs,
 *    design preference, "unclear whether this was intended").
 *  - 'needs_environment': a real behavioral claim that can only be shown with
 *    network, a database, real filesystem/OS state, concurrency timing, UI,
 *    or an external service — no deterministic unit-level reframing exists.
 *  - 'insufficient_context': behavioral and probably unit-testable, but the
 *    code supplied to the author is not enough to write a test that compiles
 *    (e.g. needed types/constructors are not shown), or the witness path is taken.
 */
export type NotTestableKind = 'opinion' | 'needs_environment' | 'insufficient_context';

/**
 * A finding's assertion restated in testable form. When `testable` is false,
 * the symbol/input/expected/actual fields may be empty strings and
 * `notTestableKind` + `notTestableReason` must be set.
 * All string fields are model output derived from untrusted PR content:
 * display them escaped, never execute or interpolate them into commands.
 */
export interface Claim {
  testable: boolean;
  /** Required when testable === false. */
  notTestableKind?: NotTestableKind;
  /** One sentence for humans; required when testable === false. */
  notTestableReason?: string;
  language: WitnessLanguage;
  /** Repo-relative path of the file that defines the symbol under test. */
  file: string;
  /** Function/method under test, e.g. "containsAny" or "(*Store).Mutate". */
  symbol: string;
  /** The concrete input/setup, e.g. `containsAny("laptop sales", ["tpm"])`. */
  input: string;
  /** What correct code returns/does for that input (what the witness asserts). */
  expected: string;
  /** What the finding says the code actually returns/does instead (the bug). */
  actual: string;
}

/** Fixed names the runner relies on; the prompt states the same values. */
export const GO_WITNESS_FILENAME = 'zz_gsr_witness_test.go';
export const GO_WITNESS_TEST_NAME = 'TestGSRWitness';
/** Jest: `<basename>.gsr-witness.test.(js|ts)` next to the file under test, single `test('gsr witness', ...)`. */
export const JEST_WITNESS_SUFFIX = '.gsr-witness.test';
export const JEST_WITNESS_TEST_NAME = 'gsr witness';

/**
 * The test file the author returns. The runner MUST reject (=> 'no_witness')
 * a file whose path is not exactly the allowed pattern in the directory of
 * `Claim.file`, or whose path already exists in the checkout:
 *   go:   <dir of Claim.file>/zz_gsr_witness_test.go, same `package` clause
 *         as Claim.file (not `<pkg>_test`), one func TestGSRWitness.
 *   jest: <dir of Claim.file>/<basename without ext>.gsr-witness.test.ts
 *         (typescript) or .js (javascript), one test('gsr witness', ...).
 */
export interface WitnessFile {
  /** Repo-relative path (forward slashes, no `..`, no leading `/`). */
  path: string;
  language: WitnessLanguage;
  framework: WitnessFramework;
  /** Full file contents. Untrusted code: only ever run inside the sandbox. */
  source: string;
}

/** What the witness author (Gemini, structured JSON output) returns. */
export interface WitnessAuthorOutput {
  claim: Claim;
  /** null iff claim.testable === false. */
  witness: WitnessFile | null;
}

/**
 * One sandboxed execution of the witness against one commit.
 * The runner, not the verdict function, is responsible for deriving these
 * flags from the tool output; exit codes alone cannot do it (verified with
 * go1.24 and jest 30: `go test` exits 1 for an assertion failure, a compile
 * error, a vet error, a panic AND a timeout; it exits 0 when the -run filter
 * matched nothing or the test called t.Skip; jest exits 1 for an assertion
 * failure, a syntax error, a missing module and an empty suite, and 0 for a
 * test.skip).
 */
export interface SandboxRunResult {
  /** Process exit code, or null if the runner killed it. Informational only. */
  exitCode: number | null;
  /** The runner's wall-clock limit or the framework's own timeout fired
   *  (go: "panic: test timed out"). Takes precedence over every other field. */
  timedOut: boolean;
  /** The witness never got to execute because the test binary/suite could not
   *  be built or loaded: compile/type/vet/syntax error, unresolved import,
   *  duplicate symbol, or a top-level throw while loading the suite (go
   *  `[build failed]`/`[setup failed]`; jest "Test suite failed to run",
   *  numRuntimeErrorTestSuites > 0). Never evidence that the claim is true. */
  buildFailed: boolean;
  /**
   * The witness test's own result, read from structured output (`go test
   * -json` events for Test == "TestGSRWitness"; jest `--json`
   * assertionResults), NOT from exitCode:
   *  - 'pass': the witness test ran and passed.
   *  - 'fail': the witness test ran and failed (assertion, panic, or throw
   *    while exercising the code under test).
   *  - 'not_run': skipped, filtered out, zero tests collected, more than one
   *    test, or no parseable result. Also used whenever timedOut/buildFailed.
   */
  witnessOutcome: 'pass' | 'fail' | 'not_run';
  /** Last few KB of combined stdout/stderr (runner caps it, e.g. 4096 chars).
   *  For humans/debugging only; may contain attacker-influenced text. */
  outputTail: string;
}

/** Final, code-decided verdict for one finding. */
export type WitnessVerdict =
  | 'proven_regression'   // witness fails on head (both runs); passes, or can't run, on base
  | 'proven_preexisting'  // witness fails on head (both runs) and fails on base
  | 'refuted'             // witness passes on head (both runs)
  | 'hypothesis'          // no conclusive witness: not unit-testable, no/invalid witness, build failure, timeout, or flaky
  | 'opinion';            // not testable by nature (style, docs, design)

/** Input to the pure verdict function. See the decision table at the top of this file. */
export type VerdictInput =
  /** Author returned testable:false. */
  | { kind: 'not_testable'; notTestableKind: NotTestableKind }
  /** Claim was testable but nothing runnable came out: author error/invalid
   *  JSON, path rejected by the runner, or the sandbox was unavailable. */
  | { kind: 'no_witness' }
  | {
      kind: 'executed';
      /** First run on the PR head commit. */
      headRun: SandboxRunResult;
      /** Second, independent run on the PR head commit (flake detection). Always performed. */
      headRerun: SandboxRunResult;
      /**
       * Run on the PR base commit, or null when the code under test does not
       * exist on base (file/symbol added by the PR) or base itself cannot be
       * built. A non-null run with buildFailed/timedOut is treated the same
       * as null. Ignored unless both head runs conclusively fail.
       */
      baseRun: SandboxRunResult | null;
    };
