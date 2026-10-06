import { classifyRun, decideVerdict } from '../src/witness/verdict';
import type { SandboxRunResult, VerdictInput } from '../src/witness/types';

describe('classifyRun', () => {
  // Helper to build a run with sensible defaults (conclusive pass)
  const run = (overrides?: Partial<SandboxRunResult>): SandboxRunResult => ({
    exitCode: 0,
    timedOut: false,
    buildFailed: false,
    witnessOutcome: 'pass',
    outputTail: '',
    ...overrides,
  });

  describe('inconclusive outcomes', () => {
    it('returns inconclusive when timedOut is true', () => {
      expect(classifyRun(run({ timedOut: true, witnessOutcome: 'fail' }))).toBe('inconclusive');
    });

    it('returns inconclusive when buildFailed is true', () => {
      expect(classifyRun(run({ buildFailed: true, witnessOutcome: 'fail' }))).toBe('inconclusive');
    });

    it('returns inconclusive when witnessOutcome is not_run', () => {
      expect(classifyRun(run({ witnessOutcome: 'not_run' }))).toBe('inconclusive');
    });

    it('timedOut takes precedence over other flags', () => {
      expect(classifyRun(run({ timedOut: true, buildFailed: true, witnessOutcome: 'fail' }))).toBe('inconclusive');
    });
  });

  describe('conclusive outcomes', () => {
    it('returns pass when witnessOutcome is pass', () => {
      expect(classifyRun(run({ witnessOutcome: 'pass' }))).toBe('pass');
    });

    it('returns fail when witnessOutcome is fail', () => {
      expect(classifyRun(run({ witnessOutcome: 'fail' }))).toBe('fail');
    });
  });

  describe('exitCode and outputTail are never consulted', () => {
    it('ignores exitCode and outputTail when classifying', () => {
      const result1 = classifyRun(run({
        witnessOutcome: 'pass',
        exitCode: 0,
        outputTail: 'success',
      }));
      const result2 = classifyRun(run({
        witnessOutcome: 'pass',
        exitCode: 1,
        outputTail: 'failure message',
      }));
      expect(result1).toBe(result2);
      expect(result1).toBe('pass');
    });

    it('ignores exitCode and outputTail for fail outcome too', () => {
      const result1 = classifyRun(run({
        witnessOutcome: 'fail',
        exitCode: 1,
        outputTail: 'test failed',
      }));
      const result2 = classifyRun(run({
        witnessOutcome: 'fail',
        exitCode: 0,
        outputTail: 'success output but test marked fail',
      }));
      expect(result1).toBe(result2);
      expect(result1).toBe('fail');
    });
  });
});

describe('decideVerdict', () => {
  const run = (overrides?: Partial<SandboxRunResult>): SandboxRunResult => ({
    exitCode: 0,
    timedOut: false,
    buildFailed: false,
    witnessOutcome: 'pass',
    outputTail: '',
    ...overrides,
  });

  describe('not_testable kind', () => {
    it('returns opinion when notTestableKind is opinion', () => {
      const input: VerdictInput = {
        kind: 'not_testable',
        notTestableKind: 'opinion',
      };
      expect(decideVerdict(input)).toBe('opinion');
    });

    it('returns hypothesis when notTestableKind is needs_environment', () => {
      const input: VerdictInput = {
        kind: 'not_testable',
        notTestableKind: 'needs_environment',
      };
      expect(decideVerdict(input)).toBe('hypothesis');
    });

    it('returns hypothesis when notTestableKind is insufficient_context', () => {
      const input: VerdictInput = {
        kind: 'not_testable',
        notTestableKind: 'insufficient_context',
      };
      expect(decideVerdict(input)).toBe('hypothesis');
    });
  });

  describe('no_witness kind', () => {
    it('returns hypothesis', () => {
      const input: VerdictInput = {
        kind: 'no_witness',
      };
      expect(decideVerdict(input)).toBe('hypothesis');
    });
  });

  describe('executed kind', () => {
    describe('inconclusive head runs', () => {
      it('returns hypothesis when headRun is inconclusive', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ timedOut: true }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('hypothesis');
      });

      it('returns hypothesis when headRerun is inconclusive', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ buildFailed: true }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('hypothesis');
      });

      it('returns hypothesis when both head runs are inconclusive', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ timedOut: true }),
          headRerun: run({ buildFailed: true }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('hypothesis');
      });
    });

    describe('flaky witness (disagreement between head runs)', () => {
      it('returns hypothesis when one pass and one fail', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'pass' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('hypothesis');
      });

      it('returns hypothesis when one fail and one pass', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'pass' }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('hypothesis');
      });
    });

    describe('both head runs pass', () => {
      it('returns refuted', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'pass' }),
          headRerun: run({ witnessOutcome: 'pass' }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('refuted');
      });

      it('returns refuted even when base fails', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'pass' }),
          headRerun: run({ witnessOutcome: 'pass' }),
          baseRun: run({ witnessOutcome: 'fail' }),
        };
        expect(decideVerdict(input)).toBe('refuted');
      });

      it('returns refuted even when base is inconclusive', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'pass' }),
          headRerun: run({ witnessOutcome: 'pass' }),
          baseRun: run({ timedOut: true }),
        };
        expect(decideVerdict(input)).toBe('refuted');
      });
    });

    describe('both head runs fail, base varies', () => {
      it('returns proven_preexisting when base fails', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: run({ witnessOutcome: 'fail' }),
        };
        expect(decideVerdict(input)).toBe('proven_preexisting');
      });

      it('returns proven_regression when base passes', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: run({ witnessOutcome: 'pass' }),
        };
        expect(decideVerdict(input)).toBe('proven_regression');
      });

      it('returns proven_regression when baseRun is null', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: null,
        };
        expect(decideVerdict(input)).toBe('proven_regression');
      });

      it('returns proven_regression when base is inconclusive (buildFailed)', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: run({ buildFailed: true }),
        };
        expect(decideVerdict(input)).toBe('proven_regression');
      });

      it('returns proven_regression when base is inconclusive (timedOut)', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: run({ timedOut: true }),
        };
        expect(decideVerdict(input)).toBe('proven_regression');
      });

      it('returns proven_regression when base is inconclusive (not_run)', () => {
        const input: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: run({ witnessOutcome: 'not_run' }),
        };
        expect(decideVerdict(input)).toBe('proven_regression');
      });
    });

    describe('edge case: exitCode and outputTail never influence verdict', () => {
      it('same verdict despite different exitCode and outputTail in base run', () => {
        const base1 = run({
          witnessOutcome: 'fail',
          exitCode: 1,
          outputTail: 'error details',
        });
        const base2 = run({
          witnessOutcome: 'fail',
          exitCode: 0,
          outputTail: 'different output entirely',
        });

        const input1: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: base1,
        };

        const input2: VerdictInput = {
          kind: 'executed',
          headRun: run({ witnessOutcome: 'fail' }),
          headRerun: run({ witnessOutcome: 'fail' }),
          baseRun: base2,
        };

        expect(decideVerdict(input1)).toBe(decideVerdict(input2));
        expect(decideVerdict(input1)).toBe('proven_preexisting');
      });
    });
  });
});
