// Ground-truth scoring against the seeded-bug PRs (fixtures/seeded_bugs.json) and, via
// fixture-regression.ts, the job_tracker audit fixture. Scores an arm against KNOWN answers, never
// against another arm: this is the precision/recall measure that matters. computeRecall against the
// baseline (validation.ts) stays as a secondary measure — it rewards whichever model writes more.
import * as fs from 'fs';
import * as path from 'path';
import { ReviewFinding } from './api-client';
import { filePathsMatch } from './validation';

export interface SeededLocation { file: string; lineStart: number; lineEnd: number }
export interface SeededBug {
  id: string;
  prUrl: string;
  branch?: string;
  prTitle?: string;
  summary: string;
  locations: SeededLocation[];
  evidence?: string;
}
export interface SeededFixture {
  description: string;
  lineTolerance: number;
  entries: SeededBug[];
}

export type ScoredSource = 'basic' | 'subagent' | 'any';

export function loadSeededFixture(file = path.join(__dirname, 'fixtures', 'seeded_bugs.json')): SeededFixture {
  const fx: SeededFixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(fx.entries) || fx.entries.length === 0) throw new Error(`${file}: no entries`);
  for (const e of fx.entries) {
    if (!e.locations?.length) throw new Error(`${file}: entry ${e.id} has no locations`);
    for (const l of e.locations) if (!(l.lineStart <= l.lineEnd)) throw new Error(`${file}: entry ${e.id} has an inverted line range`);
  }
  return fx;
}

export function inScope(f: ReviewFinding, source: ScoredSource): boolean {
  return source === 'any' || (f.source ?? 'basic') === source;
}

function within(f: ReviewFinding, loc: SeededLocation, tol: number): boolean {
  return !!f.fileName && filePathsMatch(f.fileName, loc.file) && f.lineNumber >= loc.lineStart - tol && f.lineNumber <= loc.lineEnd + tol;
}

const HIGH = new Set(['HIGH', 'CRITICAL']);

export interface SeededPrScore {
  prUrl: string;
  bugId: string;
  caught: boolean;
  matchedSummary?: string;
  findings: number;          // in-scope findings on this PR
  highUnmatched: number;     // HIGH/CRITICAL in-scope findings outside EVERY expected window of this PR
}

// `findingsByPr[url]` is the accepted run's findings for that PR (one repetition), or undefined
// when the PR has no usable run — those PRs are omitted from the score rather than counted as a
// miss, so a failed review is a coverage problem the report shows, not a quiet 0% catch rate.
export function scoreSeeded(
  fx: SeededFixture,
  findingsByPr: Record<string, ReviewFinding[] | undefined>,
  source: ScoredSource
): SeededPrScore[] {
  const out: SeededPrScore[] = [];
  for (const bug of fx.entries) {
    const all = findingsByPr[bug.prUrl];
    if (!all) continue;
    const scoped = all.filter(f => inScope(f, source));
    const matches = scoped.filter(f => bug.locations.some(l => within(f, l, fx.lineTolerance)));
    const samePr = fx.entries.filter(e => e.prUrl === bug.prUrl);
    const highUnmatched = scoped.filter(
      f => HIGH.has((f.severity || '').toUpperCase()) && !samePr.some(e => e.locations.some(l => within(f, l, fx.lineTolerance)))
    ).length;
    out.push({
      prUrl: bug.prUrl,
      bugId: bug.id,
      caught: matches.length > 0,
      matchedSummary: matches[0] ? String((matches[0] as any).summary || matches[0].issueDescription || '').slice(0, 120) : undefined,
      findings: scoped.length,
      highUnmatched,
    });
  }
  return out;
}
