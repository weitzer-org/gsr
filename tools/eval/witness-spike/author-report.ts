// Prints per-arm summaries and a per-case verdict table from author-bench result files, so the numbers in
// AUTHOR-RESULTS.md can be regenerated instead of copied.
//
//   ts-node witness-spike/author-report.ts <label=prefix[,prefix...]> ...
//   e.g. ts-node witness-spike/author-report.ts v1-single=heldout-v1-single-run v2-whole=heldout-v2-whole-run
//
// Each argument is `label=prefix[,prefix...]`: every .json file in fixtures/witness-author-runs that starts with ANY
// of the prefixes is pooled into that arm. A prefix can match more files than intended (`author-v2` also matches
// `author-v2-ruleonly-*`), so the matched file list is printed per arm: check it. All pooled files should cover
// the same finding ids.

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(__dirname, '..', 'fixtures', 'witness-author-runs');
const ABBR: Record<string, string> = { proven_regression: 'P', proven_preexisting: 'PP', refuted: 'R', hypothesis: 'H', opinion: 'O' };

interface Sample { id: string; verdict: string | null; outcome: string; costUsd: number; authorFailure?: string }
interface Arm { label: string; files: string[]; samples: Sample[] }

function loadArm(spec: string): Arm {
  const [label, prefix] = spec.split('=');
  if (!label || !prefix) throw new Error(`bad arm spec ${spec}; want label=prefix`);
  const prefixes = prefix.split(',');
  const files = fs.readdirSync(DIR).filter((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.json')).sort();
  if (!files.length) throw new Error(`no files match ${prefix}`);
  const samples = files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).samples as Sample[]);
  return { label, files, samples };
}

export function armLine(a: Arm): string {
  const c = (o: string) => a.samples.filter((s) => s.outcome === o).length;
  const proven = c('correct_proven') + c('misattributed_proven') + c('wrong_proven');
  const cost = a.samples.reduce((t, s) => t + s.costUsd, 0) / a.samples.length;
  return `${a.label.padEnd(14)} files ${a.files.length}  samples ${String(a.samples.length).padEnd(4)} proven ${String(proven).padEnd(3)} WRONG ${c('wrong_proven')}  false-refuted ${c('false_refutation')}  correct-refuted ${String(c('correct_refuted')).padEnd(3)} no-conclusion ${c('no_conclusion')}  author-failures ${c('author_failure')}  $/call ${cost.toFixed(4)}`;
}

if (require.main === module) {
  const arms = process.argv.slice(2).map(loadArm);
  for (const a of arms) console.log(armLine(a) + '\n    ' + a.files.join(', '));
  const ids = [...new Set(arms.flatMap((a) => a.samples.map((s) => s.id)))].sort();
  console.log('\n' + 'case'.padEnd(42) + arms.map((a) => a.label.padEnd(16)).join(''));
  for (const id of ids) {
    console.log(id.padEnd(42) + arms.map((a) => {
      const counts: Record<string, number> = {};
      for (const s of a.samples.filter((x) => x.id === id)) { const k = s.verdict ? ABBR[s.verdict] : 'F'; counts[k] = (counts[k] ?? 0) + 1; }
      return Object.entries(counts).sort().map(([k, v]) => `${k}${v}`).join(' ').padEnd(16);
    }).join(''));
  }
}
