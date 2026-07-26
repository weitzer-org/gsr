import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

import { runReview, ReviewFinding } from './api-client';
import { filePathsMatch } from './validation';

/**
 * Fixed, known-answer regression suite (review-quality-design.md §7.1),
 * separate from evaluate.ts's comparative harness: this scores a target
 * against ground truth from the manual job_tracker PR audit, not against
 * another target's output.
 */

interface FixtureEntryBase {
  id: string;
  prUrl: string;
  file: string;
  line: number;
  summary: string;
}

interface CrossFileEntry extends FixtureEntryBase {
  definedInFile: string;
  claimPatterns: string[];
}

interface Fixture {
  description: string;
  lineTolerance: number;
  entries: {
    must_catch: FixtureEntryBase[];
    must_not_flag_high: FixtureEntryBase[];
    must_resolve_cross_file: CrossFileEntry[];
  };
}

type Category = 'must_catch' | 'must_not_flag_high' | 'must_resolve_cross_file';

interface ScoreResult {
  id: string;
  category: Category;
  prUrl: string;
  file: string;
  line: number;
  pass: boolean;
  detail: string;
}

const HIGH_SEVERITIES = new Set(['HIGH', 'CRITICAL']);

// The audit that seeded this fixture came entirely from job_tracker's
// production CI, which runs `mode: basic` exclusively (review-quality-design.md
// §1) — the subagent swarm has zero production data on this repo. Scoring
// against basic-mode findings specifically (not the combined basic+subagent
// set /api/review returns) is what makes this a faithful regression check on
// production behavior, not just on whichever mode happens to catch it.
const SCORED_SOURCE = 'basic';

function findingText(f: ReviewFinding): string {
  const anyF = f as any;
  return (anyF.description || f.issueDescription || anyF.summary || anyF.issue || '').toString();
}

function findMatches(findings: ReviewFinding[], file: string, line: number, tolerance: number): ReviewFinding[] {
  return findings.filter(f =>
    f.fileName &&
    filePathsMatch(f.fileName, file) &&
    Math.abs((f.lineNumber ?? 0) - line) <= tolerance
  );
}

function scoreMustCatch(entry: FixtureEntryBase, findings: ReviewFinding[], tolerance: number): ScoreResult {
  const matches = findMatches(findings, entry.file, entry.line, tolerance);
  const pass = matches.length > 0;
  return {
    id: entry.id, category: 'must_catch', prUrl: entry.prUrl, file: entry.file, line: entry.line, pass,
    detail: pass
      ? `reproduced: "${findingText(matches[0]).slice(0, 100)}"`
      : 'not reproduced by current build (recall regression)'
  };
}

function scoreMustNotFlagHigh(entry: FixtureEntryBase, findings: ReviewFinding[], tolerance: number): ScoreResult {
  const matches = findMatches(findings, entry.file, entry.line, tolerance);
  const highMatches = matches.filter(m => HIGH_SEVERITIES.has((m.severity || '').toUpperCase()));
  const pass = highMatches.length === 0;
  return {
    id: entry.id, category: 'must_not_flag_high', prUrl: entry.prUrl, file: entry.file, line: entry.line, pass,
    detail: pass
      ? 'absent or capped below HIGH/CRITICAL'
      : `still flagged at ${highMatches[0].severity}: "${findingText(highMatches[0]).slice(0, 100)}"`
  };
}

function scoreMustResolveCrossFile(entry: CrossFileEntry, findings: ReviewFinding[], tolerance: number): ScoreResult {
  const matches = findMatches(findings, entry.file, entry.line, tolerance);
  const falseClaims = matches.filter(m => {
    const text = findingText(m).toLowerCase();
    return entry.claimPatterns.some(p => text.includes(p.toLowerCase()));
  });
  const pass = falseClaims.length === 0;
  return {
    id: entry.id, category: 'must_resolve_cross_file', prUrl: entry.prUrl, file: entry.file, line: entry.line, pass,
    detail: pass
      ? 'no false non-existence claim'
      : `still wrongly claims non-existence (defined in ${entry.definedInFile}): "${findingText(falseClaims[0]).slice(0, 100)}"`
  };
}

export async function runFixtureRegression(fixturePath: string, baseUrl: string, githubPat: string): Promise<{ allPass: boolean; results: ScoreResult[] }> {
  const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const allEntries: Array<{ category: Category; entry: FixtureEntryBase | CrossFileEntry }> = [
    ...fixture.entries.must_catch.map(entry => ({ category: 'must_catch' as const, entry })),
    ...fixture.entries.must_not_flag_high.map(entry => ({ category: 'must_not_flag_high' as const, entry })),
    ...fixture.entries.must_resolve_cross_file.map(entry => ({ category: 'must_resolve_cross_file' as const, entry }))
  ];

  const entriesByPr = new Map<string, typeof allEntries>();
  for (const item of allEntries) {
    const list = entriesByPr.get(item.entry.prUrl) ?? [];
    list.push(item);
    entriesByPr.set(item.entry.prUrl, list);
  }

  const results: ScoreResult[] = [];

  for (const [prUrl, items] of entriesByPr.entries()) {
    console.log(`\n🔍 Reviewing ${prUrl} (${items.length} fixture entr${items.length === 1 ? 'y' : 'ies'})...`);
    let scopedFindings: ReviewFinding[] = [];
    let reviewError: string | undefined;
    try {
      const { findings } = await runReview(baseUrl, prUrl, githubPat);
      scopedFindings = findings.filter(f => (f.source ?? SCORED_SOURCE) === SCORED_SOURCE);
      console.log(`  ${findings.length} total findings, ${scopedFindings.length} from '${SCORED_SOURCE}' mode.`);
    } catch (e: any) {
      reviewError = e.message;
      console.error(`  ❌ Review failed: ${reviewError}`);
    }

    for (const { category, entry } of items) {
      // A failed review call has no signal either way — reporting it as a
      // pass (e.g. "no HIGH finding" because there were no findings at all)
      // would be a false green, so fail every entry for this PR explicitly
      // instead of scoring against an empty findings array.
      if (reviewError) {
        results.push({
          id: entry.id, category, prUrl, file: entry.file, line: entry.line, pass: false,
          detail: `review call failed, cannot verify: ${reviewError}`
        });
      } else if (category === 'must_catch') {
        results.push(scoreMustCatch(entry, scopedFindings, fixture.lineTolerance));
      } else if (category === 'must_not_flag_high') {
        results.push(scoreMustNotFlagHigh(entry, scopedFindings, fixture.lineTolerance));
      } else {
        results.push(scoreMustResolveCrossFile(entry as CrossFileEntry, scopedFindings, fixture.lineTolerance));
      }
    }
  }

  return { allPass: printReport(results), results };
}

function printReport(results: ScoreResult[]): boolean {
  const categories: Category[] = ['must_catch', 'must_not_flag_high', 'must_resolve_cross_file'];
  let allPass = true;

  console.log('\n================ Fixture Regression Report ================');
  for (const category of categories) {
    const rs = results.filter(r => r.category === category);
    if (rs.length === 0) continue;
    const passing = rs.filter(r => r.pass).length;
    console.log(`\n${category} (${passing}/${rs.length} passing)`);
    for (const r of rs) {
      if (!r.pass) allPass = false;
      console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.id} — ${r.file}:${r.line} — ${r.detail}`);
    }
  }
  console.log(`\n${allPass ? '✅ All fixture entries passing' : '❌ Fixture regression(s) present'}`);
  console.log('=============================================================\n');

  return allPass;
}

if (require.main === module) {
  const fixturePath = process.argv.includes('--fixture')
    ? process.argv[process.argv.indexOf('--fixture') + 1]
    : path.join(__dirname, 'fixtures', 'job_tracker_regressions.json');

  const baseUrl = process.env.TARGET_URL || process.env.LOCAL_URL || 'http://localhost:8080';
  const githubPat = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;

  if (!githubPat) {
    console.error('❌ GITHUB_TOKEN (or GITHUB_PAT) environment variable is required.');
    process.exit(1);
  }

  runFixtureRegression(fixturePath, baseUrl, githubPat)
    .then(({ allPass }) => {
      process.exitCode = allPass ? 0 : 1;
    })
    .catch(err => {
      console.error('\n💥 Unhandled error in fixture regression run:', err);
      process.exitCode = 1;
    });
}
