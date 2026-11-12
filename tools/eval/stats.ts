// Per-PR statistics for candidate-vs-baseline comparisons.
//
// The unit is the PR, never the finding and never the repetition: each PR contributes ONE number
// per arm per measure (the mean over that PR's repetitions), so the 23 PRs are 23 observations,
// not 46 or hundreds. Findings within a PR are not independent; two repetitions of one PR are not
// independent either.
//
// The verdict rules are Sound Builder's #271 rules (docs/eval/single-agent-ab.md §2d), fixed in
// advance and pinned by tests/stats.test.ts. Do not tune them after looking at a result.
//
//   count measure  (findings, valid findings, ...)  change = (mean cand / mean base - 1) * 100, in %
//   share measure  (recall, catch rate, ...)        change = (mean cand - mean base) * 100, in points
//
//   FAIL  the whole 95% bootstrap interval of the change is below -10
//   WARN  the interval's upper bound is below 0 AND the exact two-sided sign test has p <= 0.10
//   PASS  otherwise.   WARN is NOT a pass.
//   Fewer than MIN_PAIRS paired PRs: identical data PASSes, anything else is UNMEASURED.

export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'UNMEASURED';
export type MeasureKind = 'count' | 'share';

export const FAIL_BELOW = -10;
export const WARN_SIGN_P = 0.1;
export const MIN_PAIRS = 4;
export const BOOTSTRAP_RESAMPLES = 4000;
export const DEFAULT_SEED = 20261112;

// mulberry32: tiny deterministic PRNG so a report regenerated from the same batch is identical.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  // Linear interpolation between closest ranks.
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// log C(n, k) via summed logs; fine for the n <= a few hundred this is used with.
function logChoose(n: number, k: number): number {
  let r = 0;
  for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
  return r;
}

// Exact two-sided sign test on the non-tied pairs: p = min(1, 2 * P(X <= min(lower, higher))),
// X ~ Binomial(n, 0.5), n = lower + higher.
export function signTestP(lower: number, higher: number): number {
  const n = lower + higher;
  if (n === 0) return 1;
  const k = Math.min(lower, higher);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

export interface MeasureComparison {
  kind: MeasureKind;
  n: number;              // paired PRs used (pairs with a missing value on either side are dropped)
  meanBase: number;
  meanCand: number;
  meanDiff: number;       // meanCand - meanBase, in the measure's own units
  change: number;         // % for counts, points for shares (see header)
  changeUnit: '%' | 'points';
  lower: number;          // PRs where the candidate is lower / higher / equal
  higher: number;
  equal: number;
  signP: number;
  ci: [number, number];   // 95% bootstrap interval of `change`, same unit
  verdict: Verdict;
  reason: string;
}

function changeOf(candMean: number, baseMean: number, kind: MeasureKind): number {
  if (kind === 'share') return (candMean - baseMean) * 100;
  if (baseMean === 0) return candMean === 0 ? 0 : Infinity;
  return (candMean / baseMean - 1) * 100;
}

const EPS = 1e-12;

export function compareMeasure(
  cand: readonly number[],
  base: readonly number[],
  kind: MeasureKind,
  opts: { seed?: number; resamples?: number; minPairs?: number } = {}
): MeasureComparison {
  if (cand.length !== base.length) throw new Error(`compareMeasure: ${cand.length} candidate values vs ${base.length} baseline values (must be paired by PR)`);
  const resamples = opts.resamples ?? BOOTSTRAP_RESAMPLES;
  const minPairs = opts.minPairs ?? MIN_PAIRS;
  const c: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < cand.length; i++) {
    if (Number.isFinite(cand[i]) && Number.isFinite(base[i])) {
      c.push(cand[i]);
      b.push(base[i]);
    }
  }
  const n = c.length;
  const meanC = mean(c);
  const meanB = mean(b);
  let lower = 0, higher = 0, equal = 0;
  for (let i = 0; i < n; i++) {
    const d = c[i] - b[i];
    if (Math.abs(d) <= EPS) equal++;
    else if (d < 0) lower++;
    else higher++;
  }
  const signP = signTestP(lower, higher);
  const changeUnit = kind === 'share' ? 'points' : '%';
  const change = n === 0 ? NaN : changeOf(meanC, meanB, kind);
  const base0 = { kind, n, meanBase: meanB, meanCand: meanC, meanDiff: meanC - meanB, change, changeUnit, lower, higher, equal, signP } as const;

  if (n < minPairs) {
    const identical = n > 0 && lower === 0 && higher === 0;
    return {
      ...base0, ci: [NaN, NaN],
      verdict: identical ? 'PASS' : 'UNMEASURED',
      reason: identical ? `only ${n} paired PRs, but identical` : `only ${n} paired PR${n === 1 ? '' : 's'} (< ${minPairs})`,
    };
  }

  const rng = makeRng(opts.seed ?? DEFAULT_SEED);
  const changes: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sc = 0, sb = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      sc += c[j];
      sb += b[j];
    }
    changes[r] = changeOf(sc / n, sb / n, kind);
  }
  changes.sort((x, y) => x - y);
  const lo = changes[Math.floor(0.025 * (resamples - 1))];
  const hi = changes[Math.ceil(0.975 * (resamples - 1))];

  let verdict: Verdict = 'PASS';
  let reason = `interval [${fmt(lo)}, ${fmt(hi)}] ${changeUnit}, sign p=${signP.toFixed(3)}`;
  if (hi < FAIL_BELOW) {
    verdict = 'FAIL';
    reason = `whole interval below ${FAIL_BELOW}: ${reason}`;
  } else if (hi < 0 && signP <= WARN_SIGN_P) {
    verdict = 'WARN';
    reason = `interval below 0 and sign test p<=${WARN_SIGN_P}: ${reason}`;
  }
  return { ...base0, ci: [lo, hi], verdict, reason };
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  return x.toFixed(1);
}

// Averages a per-run value to one number per PR. `rows` is [{pr, value}] with several rows per PR
// (one per repetition); a PR with no finite value gets NaN so compareMeasure drops its pair.
export function perPrMeans(rows: ReadonlyArray<{ pr: string; value: number }>, prs: readonly string[]): number[] {
  return prs.map(pr => {
    const vals = rows.filter(r => r.pr === pr && Number.isFinite(r.value)).map(r => r.value);
    return vals.length ? mean(vals) : NaN;
  });
}
