// Selects the "large PR" set for the model-upgrade eval by a WRITTEN RULE (docs/eval/model-upgrade-test-plan.md §3), so the
// choice cannot be made after seeing results. Read-only GitHub API calls; no Gemini calls.
//
// The rule, in full:
//   repos        weitzer-org/sound-profile-builder and weitzer-org/gsr, taken alternately (spb first)
//   candidates   MERGED PRs, newest merge first, merged on or before the cutoff date, at most the
//                SCAN_LIMIT most recently merged per repo, not already in config.json's sample_prs
//   qualifies    >= 10 changed CODE files (extension in CODE_EXTENSIONS, not under docs/, and
//                present in the review's diff: has a patch and is not on the backend's ignore list)
//                AND total patch size <= MAX_PATCH_BYTES (keeps one PR from dominating cost)
//   take         the first PER_REPO that qualify from each repo (10 in total)
// Docs-only PRs cannot qualify: markdown/text files are not code files.
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

export const REPOS = ['weitzer-org/sound-profile-builder', 'weitzer-org/gsr'] as const;
export const MIN_CODE_FILES = 10;
export const MAX_PATCH_BYTES = 1_000_000;
export const SCAN_LIMIT = 60;
export const PER_REPO = 5;
export const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'py', 'rs', 'java', 'kt', 'rb', 'sh', 'sql', 'css', 'scss', 'html']);

// Mirrors the ignore list in adk/backend/src/github.ts getPRDiff.
const BACKEND_IGNORED = [/package-lock\.json$/i, /yarn\.lock$/i, /pnpm-lock\.yaml$/i, /\.min\.js$/i, /\.bundle\.js$/i, /\.svg$/i, /^dist\//i, /^build\//i];

export interface PrFile { filename: string; patch?: string }

export function isCodeFile(f: PrFile): boolean {
  if (!f.patch) return false;
  if (BACKEND_IGNORED.some(p => p.test(f.filename))) return false;
  if (/^docs?\//i.test(f.filename)) return false;
  const ext = f.filename.split('.').pop()?.toLowerCase() ?? '';
  return CODE_EXTENSIONS.has(ext);
}

export function qualifies(files: PrFile[]): { ok: boolean; codeFiles: number; totalFiles: number; patchBytes: number } {
  const patchBytes = files.reduce((s, f) => s + Buffer.byteLength(f.patch ?? '', 'utf8'), 0);
  const codeFiles = files.filter(isCodeFile).length;
  return { ok: codeFiles >= MIN_CODE_FILES && patchBytes <= MAX_PATCH_BYTES, codeFiles, totalFiles: files.length, patchBytes };
}

// Alternate between repos, newest first within each; stop a repo at PER_REPO.
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const max = Math.max(...lists.map(l => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

async function gh(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return res.json();
}

async function listFiles(repo: string, n: number, token: string): Promise<PrFile[]> {
  const all: PrFile[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch: PrFile[] = await gh(`https://api.github.com/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`, token);
    all.push(...batch.map(f => ({ filename: f.filename, patch: f.patch })));
    if (batch.length < 100) break;
  }
  return all;
}

async function selectForRepo(repo: string, exclude: Set<string>, cutoff: Date, token: string) {
  const picked: any[] = [];
  const merged: any[] = [];
  // Exhaust the pages (a paged API is incomplete after one call): up to SCAN_LIMIT merged PRs.
  for (let page = 1; page <= 10 && merged.length < SCAN_LIMIT; page++) {
    const prs: any[] = await gh(`https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, token);
    if (!prs.length) break;
    merged.push(...prs.filter(p => p.merged_at && new Date(p.merged_at) <= cutoff));
    if (prs.length < 100) break;
  }
  merged.sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
  for (const pr of merged.slice(0, SCAN_LIMIT)) {
    if (picked.length >= PER_REPO) break;
    if (exclude.has(pr.html_url)) continue;
    const files = await listFiles(repo, pr.number, token);
    const q = qualifies(files);
    if (q.ok) picked.push({ url: pr.html_url, repo, number: pr.number, title: pr.title, merged_at: pr.merged_at, code_files: q.codeFiles, total_files: q.totalFiles, patch_bytes: q.patchBytes });
  }
  return { picked, scanned: Math.min(merged.length, SCAN_LIMIT) };
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  const cutoff = new Date(process.argv.includes('--cutoff') ? process.argv[process.argv.indexOf('--cutoff') + 1] : '2026-11-12T23:59:59Z');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const exclude = new Set<string>(config.sample_prs);
  const perRepo: any[][] = [];
  const scanned: Record<string, number> = {};
  for (const repo of REPOS) {
    const r = await selectForRepo(repo, exclude, cutoff, token);
    perRepo.push(r.picked);
    scanned[repo] = r.scanned;
    console.log(`${repo}: scanned ${r.scanned} merged PRs, selected ${r.picked.length}`);
  }
  const detail = interleave(perRepo);
  const out = {
    rule: `merged PRs newest-first from ${REPOS.join(' and ')} (alternating), merged <= ${cutoff.toISOString()}, scanning at most ${SCAN_LIMIT} per repo, excluding config.json sample_prs; >= ${MIN_CODE_FILES} changed code files (${[...CODE_EXTENSIONS].join(',')}; not under docs/; with a patch; not on the backend ignore list) and total patch <= ${MAX_PATCH_BYTES} bytes; first ${PER_REPO} per repo`,
    selected_at: new Date().toISOString(),
    scanned,
    sample_prs: config.sample_prs,
    large_set: detail.map(d => d.url),
    large_set_detail: detail,
  };
  const outFile = path.join(__dirname, 'fixtures', 'model-upgrade-prs.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outFile}: ${out.sample_prs.length} config PRs + ${out.large_set.length} large PRs`);
}

if (require.main === module) main().catch(e => { console.error('💥', e.message ?? e); process.exitCode = 1; });
