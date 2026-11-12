import { describe, it, expect } from '@jest/globals';
import {
  signTestP, compareMeasure, makeRng, shuffled, percentile, perPrMeans, mean,
  FAIL_BELOW, WARN_SIGN_P, MIN_PAIRS,
} from '../stats';

describe('signTestP (exact two-sided)', () => {
  it('matches hand-computed binomial values', () => {
    expect(signTestP(0, 5)).toBeCloseTo(2 / 32, 10);      // 0.0625
    expect(signTestP(0, 4)).toBeCloseTo(2 / 16, 10);      // 0.125
    expect(signTestP(1, 9)).toBeCloseTo(2 * 11 / 1024, 10);
    expect(signTestP(5, 5)).toBe(1);
    expect(signTestP(3, 2)).toBeCloseTo(1, 10);           // min(1, 2*P(X<=2)) with n=5 -> 1
  });
  it('is symmetric and returns 1 with no non-tied pairs', () => {
    expect(signTestP(2, 9)).toBeCloseTo(signTestP(9, 2), 12);
    expect(signTestP(0, 0)).toBe(1);
  });
  it('the documented thresholds', () => {
    expect(FAIL_BELOW).toBe(-10);
    expect(WARN_SIGN_P).toBe(0.1);
    expect(MIN_PAIRS).toBe(4);
  });
});

describe('compareMeasure: the pinned FAIL / WARN / PASS rules', () => {
  const twelve = (v: number) => Array(12).fill(v);

  it('NULL COMPARISON: the same data against itself is a PASS with a zero interval, whatever the measure', () => {
    const data = [3, 7, 1, 9, 4, 4, 8, 2, 6, 5, 0, 10];
    for (const kind of ['count', 'share'] as const) {
      const r = compareMeasure(data, data, kind);
      expect(r.verdict).toBe('PASS');
      expect(r.ci).toEqual([0, 0]);
      expect(r.lower).toBe(0);
      expect(r.higher).toBe(0);
      expect(r.equal).toBe(12);
      expect(r.signP).toBe(1);
      expect(r.meanDiff).toBe(0);
    }
  });

  it('FAIL when the whole interval is below -10 % (every PR down 30 %)', () => {
    const r = compareMeasure(twelve(7), twelve(10), 'count');
    expect(r.change).toBeCloseTo(-30, 8);
    expect(r.ci[1]).toBeLessThan(-10);
    expect(r.verdict).toBe('FAIL');
  });

  it('WARN (not FAIL) for a small but consistent loss: interval below 0 but not below -10, sign test significant', () => {
    const r = compareMeasure(twelve(9.5), twelve(10), 'count');
    expect(r.ci).toEqual([expect.closeTo(-5, 8), expect.closeTo(-5, 8)]);
    expect(r.lower).toBe(12);
    expect(r.signP).toBeLessThan(WARN_SIGN_P);
    expect(r.verdict).toBe('WARN');
  });

  it('a loss whose interval is below 0 but whose sign test is NOT significant is a PASS (both conditions are required)', () => {
    // 3 PRs lower, 0 higher is p=0.25 but needs MIN_PAIRS: use 4 lower, 0 higher, p=0.125 > 0.10.
    const r = compareMeasure([9, 9, 9, 9], [10, 10, 10, 10], 'count');
    expect(r.n).toBe(4);
    expect(r.signP).toBeCloseTo(0.125, 10);
    expect(r.ci[1]).toBeLessThan(0);
    expect(r.verdict).toBe('PASS');
  });

  it('PASS for a candidate that is higher everywhere', () => {
    expect(compareMeasure(twelve(12), twelve(10), 'count').verdict).toBe('PASS');
  });

  it('PASS for noise around zero', () => {
    const cand = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10, 10, 10];
    const base = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    expect(compareMeasure(cand, base, 'count').verdict).toBe('PASS');
  });

  it('share measures change in POINTS, not percent: 0.8 vs 0.5 on every PR is +30 points', () => {
    const r = compareMeasure(twelve(0.8), twelve(0.5), 'share');
    expect(r.changeUnit).toBe('points');
    expect(r.change).toBeCloseTo(30, 8);
    const down = compareMeasure(twelve(0.5), twelve(0.8), 'share');
    expect(down.change).toBeCloseTo(-30, 8);
    expect(down.verdict).toBe('FAIL');
    // -5 points is a WARN, -15 points a FAIL.
    expect(compareMeasure(twelve(0.75), twelve(0.8), 'share').verdict).toBe('WARN');
    expect(compareMeasure(twelve(0.65), twelve(0.8), 'share').verdict).toBe('FAIL');
  });

  it('the -10 boundary is strict: a change of exactly -10 % is a WARN, not a FAIL', () => {
    const r = compareMeasure(twelve(9), twelve(10), 'count');
    expect(r.ci[1]).toBeCloseTo(-10, 8);
    expect(r.verdict).toBe('WARN');
  });

  it('fewer than MIN_PAIRS paired PRs: identical -> PASS, otherwise UNMEASURED', () => {
    expect(compareMeasure([1, 2, 3], [1, 2, 3], 'count').verdict).toBe('PASS');
    expect(compareMeasure([1, 2, 3], [4, 5, 6], 'count').verdict).toBe('UNMEASURED');
    expect(compareMeasure([], [], 'count').verdict).toBe('UNMEASURED');
  });

  it('drops pairs where either side is missing (NaN) and reports the pairs actually used', () => {
    const r = compareMeasure([1, NaN, 3, 4, 5], [1, 2, NaN, 4, 5], 'count', {});
    expect(r.n).toBe(3);
    expect(r.verdict).toBe('PASS'); // 3 < MIN_PAIRS but identical
  });

  it('a zero baseline cannot fail: 0 -> 0 is no change, 0 -> positive is +Infinity %', () => {
    expect(compareMeasure(twelve(0), twelve(0), 'count').verdict).toBe('PASS');
    expect(compareMeasure(twelve(3), twelve(0), 'count').change).toBe(Infinity);
  });

  it('counts lower / higher / equal PRs', () => {
    const r = compareMeasure([1, 2, 3, 4, 5, 6], [2, 2, 2, 5, 5, 5], 'count');
    expect([r.lower, r.equal, r.higher]).toEqual([2, 2, 2]);
  });

  it('is reproducible: same seed, same interval; different seed may differ but the verdict class is stable here', () => {
    const cand = [8, 9, 7, 10, 6, 9, 8, 7, 9, 8, 10, 7];
    const base = Array(12).fill(10);
    const a = compareMeasure(cand, base, 'count', { seed: 7 });
    const b = compareMeasure(cand, base, 'count', { seed: 7 });
    expect(a.ci).toEqual(b.ci);
  });

  it('rejects unpaired inputs', () => {
    expect(() => compareMeasure([1, 2], [1], 'count')).toThrow(/paired/);
  });

  it('a -13 % mean whose interval still reaches above -10 is a WARN, not a FAIL (pinned from a computed run)', () => {
    const base = Array(12).fill(10);
    const cand = [10, 10, 10, 10, 8, 8, 8, 8, 8, 8, 8, 8]; // mean 8.667 => -13.3 %
    const r = compareMeasure(cand, base, 'count');
    expect(r.change).toBeCloseTo(-13.33, 1);
    expect(r.ci[1]).toBeGreaterThanOrEqual(-10);
    expect(r.verdict).toBe('WARN');
  });
});

describe('helpers', () => {
  it('makeRng is deterministic and in [0,1)', () => {
    const a = makeRng(1), b = makeRng(1);
    for (let i = 0; i < 100; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });
  it('shuffled is a permutation and is seed-stable', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const s1 = shuffled(xs, makeRng(42));
    expect([...s1].sort()).toEqual(xs);
    expect(shuffled(xs, makeRng(42))).toEqual(s1);
    expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input untouched
  });
  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48, 8);
  });
  it('perPrMeans averages repetitions per PR and yields NaN for a PR with no value', () => {
    const rows = [{ pr: 'a', value: 1 }, { pr: 'a', value: 3 }, { pr: 'b', value: 5 }, { pr: 'c', value: NaN }];
    const out = perPrMeans(rows, ['a', 'b', 'c', 'd']);
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(5);
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeNaN();
    expect(mean([1, 2, 3])).toBe(2);
  });
});
