import { describe, it, expect } from '@jest/globals';
import { parseJestJson } from '../witness-spike/jest';

// Trimmed from real `jest --json` output (jest 30) for each outcome.
const suite = (assertions: { title: string; status: string }[], message = '') => ({ status: 'x', message, assertionResults: assertions });
const json = (o: object) => JSON.stringify(o);

const PASSED = json({ numRuntimeErrorTestSuites: 0, testResults: [suite([{ title: 'gsr witness', status: 'passed' }])] });
const FAILED = json({ numRuntimeErrorTestSuites: 0, testResults: [suite([{ title: 'gsr witness', status: 'failed' }], '  ● gsr witness\n\n    Expected: 180\n    Received: -1800')] });
const SUITE_FAILED_TO_RUN = json({ numRuntimeErrorTestSuites: 1, testResults: [suite([], '  ● Test suite failed to run\n\n    gsr-setup: missingFn not exported')] });
const SKIPPED = json({ numRuntimeErrorTestSuites: 0, testResults: [suite([{ title: 'gsr witness', status: 'pending' }])] });
const EMPTY = json({ numRuntimeErrorTestSuites: 0, testResults: [] });
const TWO = json({ numRuntimeErrorTestSuites: 0, testResults: [suite([{ title: 'gsr witness', status: 'passed' }, { title: 'gsr witness', status: 'passed' }])] });

const parse = (s: string, o: { timedOut?: boolean; exitCode?: number | null } = {}) => parseJestJson(s, { timedOut: o.timedOut ?? false, exitCode: 'exitCode' in o ? (o.exitCode as number | null) : 0 });

describe('parseJestJson', () => {
  it.each([
    ['a passing witness', PASSED, 0, 'pass', false],
    ['a failing assertion', FAILED, 1, 'fail', false],
    ['a suite that failed to run (load-time throw, syntax error, bad import)', SUITE_FAILED_TO_RUN, 1, 'not_run', true],
    ['a skipped/pending witness', SKIPPED, 0, 'not_run', false],
    ['no tests collected', EMPTY, 1, 'not_run', false],
    ['more than one witness test', TWO, 0, 'not_run', false],
  ])('%s', (_n, input, exitCode, outcome, buildFailed) => {
    const r = parse(input as string, { exitCode: exitCode as number });
    expect(r.witnessOutcome).toBe(outcome);
    expect(r.buildFailed).toBe(buildFailed);
  });

  it('a timeout is never a result, even if output parses as a failure', () => {
    expect(parse(FAILED, { timedOut: true, exitCode: 1 })).toMatchObject({ timedOut: true, witnessOutcome: 'not_run' });
  });

  it('treats an output/exit-code mismatch as inconclusive (forged JSON on stdout)', () => {
    expect(parse(PASSED, { exitCode: 1 }).witnessOutcome).toBe('not_run');
    expect(parse(FAILED, { exitCode: 0 }).witnessOutcome).toBe('not_run');
    expect(parse(PASSED, { exitCode: null }).witnessOutcome).toBe('not_run');
  });

  it('does not crash on forged JSON with the wrong shape (non-array testResults, null items)', () => {
    for (const bad of ['{"testResults":{}}', '{"testResults":[null]}', '{"testResults":[{"assertionResults":{}}]}', '{"testResults":[{"assertionResults":[null]}]}', '{"testResults":"x","numRuntimeErrorTestSuites":"1"}']) {
      expect(() => parse(bad)).not.toThrow();
      expect(parse(bad).witnessOutcome).toBe('not_run');
    }
  });

  it('tolerates non-JSON output and keeps it as the tail', () => {
    const r = parse('jest: command not found');
    expect(r.witnessOutcome).toBe('not_run');
    expect(r.outputTail).toContain('command not found');
  });

  it('finds the JSON object when logs surround it', () => {
    expect(parse(`warning: something\n${PASSED}\ntrailing`).witnessOutcome).toBe('pass');
  });
});
