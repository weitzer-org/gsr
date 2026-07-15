import { CandidateFinding } from './types';

const SEVERITY_SCORES: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * Decides whether findings should fail a CI run given a configured
 * minimum severity threshold ("none" always returns false).
 */
export function shouldFailOnSeverity(findings: CandidateFinding[], threshold: string): boolean {
  const normalized = threshold.toUpperCase();
  if (normalized === 'NONE') {
    return false;
  }

  const minScore = SEVERITY_SCORES[normalized];
  if (!minScore) {
    throw new Error(`Invalid fail-on-severity value "${threshold}" — must be one of: none, low, medium, high, critical.`);
  }

  return findings.some(f => (SEVERITY_SCORES[f.severity?.toUpperCase()] || 0) >= minScore);
}
