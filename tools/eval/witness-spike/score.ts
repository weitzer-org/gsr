// Scores a real author's verdicts against ground truth (author-truth.json).
// Pure and offline so it can be unit tested. The question it answers is "how
// often is a proven verdict right?", so the unit of failure is a verdict the
// pipeline would have shown to a user that contradicts the truth.

import type { WitnessVerdict } from '../../../adk/backend/src/witness/types';

export interface Truth {
  truth: 'true' | 'false' | 'opinion';
  /** For true claims: introduced/new in the PR, or already on base. */
  attribution?: 'regression' | 'preexisting';
  /** Label is arguable; reported separately where it decides a conclusion. */
  weak?: boolean;
}

export type Outcome =
  | 'correct_proven'        // proven_*, claim true, attribution matches
  | 'misattributed_proven'  // proven_*, claim true, wrong regression/preexisting label
  | 'wrong_proven'          // proven_* but the claim is false or not behavioral: a false proof
  | 'correct_refuted'       // refuted, claim false
  | 'false_refutation'      // refuted, claim true: a real finding would be collapsed
  | 'spurious_refuted'      // refuted on an opinion finding
  | 'correct_abstain'       // hypothesis/opinion on an opinion finding
  | 'no_conclusion'         // hypothesis/opinion on a behavioral finding: no yield, no harm
  | 'author_failure';       // model call failed or returned unusable JSON

export function classify(verdict: WitnessVerdict | null, t: Truth): Outcome {
  if (verdict === null) return 'author_failure';
  if (verdict === 'proven_regression' || verdict === 'proven_preexisting') {
    if (t.truth !== 'true') return 'wrong_proven';
    const got = verdict === 'proven_regression' ? 'regression' : 'preexisting';
    return got === t.attribution ? 'correct_proven' : 'misattributed_proven';
  }
  if (verdict === 'refuted') {
    if (t.truth === 'false') return 'correct_refuted';
    return t.truth === 'true' ? 'false_refutation' : 'spurious_refuted';
  }
  return t.truth === 'opinion' ? 'correct_abstain' : 'no_conclusion';
}

export interface Row { id: string; verdict: WitnessVerdict | null; outcome: Outcome; costUsd: number; costUsdWithThinking: number }

export interface Summary {
  n: number;
  counts: Record<Outcome, number>;
  proven: number;
  wrongProven: number;
  /** proven verdicts whose claim is actually true (attribution ignored); null when none were proven. */
  provenPrecision: number | null;
  conclusive: number;
  yield: number;
  costUsd: number;
  costUsdWithThinking: number;
  costPerFinding: number;
  costPerCorrectProven: number | null;
}

const OUTCOMES: Outcome[] = ['correct_proven', 'misattributed_proven', 'wrong_proven', 'correct_refuted', 'false_refutation', 'spurious_refuted', 'correct_abstain', 'no_conclusion', 'author_failure'];

export function summarize(rows: Row[]): Summary {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const r of rows) counts[r.outcome]++;
  const proven = counts.correct_proven + counts.misattributed_proven + counts.wrong_proven;
  const conclusive = proven + counts.correct_refuted + counts.false_refutation + counts.spurious_refuted;
  const costUsd = rows.reduce((s, r) => s + r.costUsd, 0);
  return {
    n: rows.length,
    counts,
    proven,
    wrongProven: counts.wrong_proven,
    provenPrecision: proven ? (counts.correct_proven + counts.misattributed_proven) / proven : null,
    conclusive,
    yield: rows.length ? conclusive / rows.length : 0,
    costUsd,
    costUsdWithThinking: rows.reduce((s, r) => s + r.costUsdWithThinking, 0),
    costPerFinding: rows.length ? costUsd / rows.length : 0,
    costPerCorrectProven: counts.correct_proven ? costUsd / counts.correct_proven : null,
  };
}
