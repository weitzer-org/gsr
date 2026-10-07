// Real-PR held-out set: GSR findings from job_tracker PRs, labelled by running
// code at the reviewed commit (fixtures/witness-realpr/LABELLING.md). The labels
// were frozen (realpr-truth.json) before any author run.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildBundle, readPackageFiles } from './bundle';
import type { Truth } from './score';

const FIX = path.join(__dirname, '..', 'fixtures', 'witness-realpr');
const REPO = process.env.JOB_TRACKER_DIR || '/home/user/job_tracker';
const WORK = process.env.REALPR_WORK_DIR || '/tmp/gsr-witness-realpr';
const GO_DIRECTIVE = '1.24'; // the sandbox image's toolchain; applied identically to head and base

interface Candidate {
  pr: number; file: string; line: number; severity: string;
  claim_summary: string; claim_full_excerpt: string;
  reviewed_commit_sha: string; pr_base_sha: string;
}

export interface RealPrFinding {
  id: string; file: string; line: number; severity: string; summary: string; description: string;
  headDir: string; baseDir: string | null; headSha: string; baseSha: string; truth: Truth & { why: string };
}

const git = (args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function ensureWorktree(dir: string, sha: string) {
  if (fs.existsSync(dir)) return;
  git(['worktree', 'add', '-q', '--detach', dir, sha]);
  const gomod = path.join(dir, 'go.mod');
  if (fs.existsSync(gomod)) {
    const src = fs.readFileSync(gomod, 'utf8').replace(/^go \d+\.\d+(\.\d+)?$/m, `go ${GO_DIRECTIVE}`).replace(/^toolchain .*\n/m, '');
    fs.writeFileSync(gomod, src);
  }
}

export const realprId = (idx: number, pr: number) => `rp-${idx}-pr${pr}`;

/** Builds the findings; with `prepare`, also creates the head/base worktrees. */
export function realprFindings(prepare = true): RealPrFinding[] {
  const cands: Candidate[] = JSON.parse(fs.readFileSync(path.join(FIX, 'candidates.json'), 'utf8')).candidates;
  const truth: Record<string, Truth & { why: string }> = JSON.parse(fs.readFileSync(path.join(__dirname, 'realpr-truth.json'), 'utf8')).cases;
  fs.mkdirSync(WORK, { recursive: true });
  return Object.keys(truth).map((id) => {
    const idx = Number(id.split('-')[1]);
    const c = cands[idx];
    if (realprId(idx, c.pr) !== id) throw new Error(`truth id ${id} does not match candidate ${idx}`);
    const baseSha = git(['merge-base', c.reviewed_commit_sha, c.pr_base_sha]);
    const headDir = path.join(WORK, `${id}-head`);
    const baseDir = path.join(WORK, `${id}-base`);
    if (prepare) { ensureWorktree(headDir, c.reviewed_commit_sha); ensureWorktree(baseDir, baseSha); }
    return {
      id, file: c.file, line: c.line, severity: c.severity.toUpperCase(),
      summary: c.claim_summary, description: c.claim_full_excerpt,
      headDir, baseDir, headSha: c.reviewed_commit_sha, baseSha, truth: truth[id],
    };
  });
}

export function realprBundle(f: RealPrFinding, whole: boolean): string {
  const dir = path.posix.dirname(f.file);
  const diff = git(['diff', '--no-color', f.baseSha, f.headSha, '--', f.file]);
  const listing = fs.existsSync(path.join(f.headDir, dir)) ? fs.readdirSync(path.join(f.headDir, dir)).sort() : [];
  const nearby = listing.find((x) => x.endsWith('_test.go'));
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  return buildBundle({
    finding: { file: f.file, line: f.line, severity: f.severity, summary: f.summary, description: f.description },
    diff,
    fileUnderTest: read(path.join(f.headDir, f.file)),
    nearby: { path: nearby ? path.posix.join(dir, nearby) : '', content: nearby ? read(path.join(f.headDir, dir, nearby)) : '' },
    dirListing: listing,
    packageFiles: whole ? readPackageFiles(f.headDir, dir, f.file) : undefined,
  });
}
