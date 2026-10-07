// Builds the witness author's input bundle. Shared by `run.ts prepare` (the
// job_tracker spike) and author-bench.ts (the testbed and the spike, with a
// real model). All text that came from a PR is untrusted and goes through
// tagSafe so it cannot open or close one of the bundle's own tags.

import * as fs from 'fs';
import * as path from 'path';

const TAGS = 'FINDING|DIFF|FILE_UNDER_TEST|NEARBY_TEST|DIR_LISTING|PACKAGE_FILE';

/** Stops untrusted text from opening or closing one of the bundle's own tags. */
export function tagSafe(text: string): string {
  return text.replace(new RegExp(`<\\s*(\\/?)\\s*(${TAGS})\\b`, 'gi'), '<\\$1$2');
}

/** An attribute value cannot be tagSafe'd (it is quoted); keep only path-like characters. */
function attrSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_./@+-]/g, '_');
}

export interface BundleInput {
  finding: { file: string; line: number; severity: string; summary: string; description?: string; suggestion?: string };
  diff: string;
  fileUnderTest: string;
  /** Existing test file in the same directory ('' path when there is none). */
  nearby: { path: string; content: string };
  dirListing: string[];
  /** Prompt v2 only: every source file of the package, so existing fakes are visible. */
  packageFiles?: { path: string; content: string }[];
}

export function buildBundle(b: BundleInput): string {
  const finding = JSON.stringify({ ...b.finding, description: b.finding.description ?? b.finding.summary }, null, 2);
  const parts = [
    `<FINDING>\n${tagSafe(finding)}\n</FINDING>`,
    `<DIFF>\n${tagSafe(b.diff)}\n</DIFF>`,
    `<FILE_UNDER_TEST path="${attrSafe(b.finding.file)}">\n${tagSafe(b.fileUnderTest)}\n</FILE_UNDER_TEST>`,
    `<NEARBY_TEST path="${attrSafe(b.nearby.path)}">\n${tagSafe(b.nearby.content)}\n</NEARBY_TEST>`,
    `<DIR_LISTING>\n${tagSafe(b.dirListing.join('\n'))}\n</DIR_LISTING>`,
  ];
  for (const f of b.packageFiles ?? []) {
    parts.push(`<PACKAGE_FILE path="${attrSafe(f.path)}">\n${tagSafe(f.content)}\n</PACKAGE_FILE>`);
  }
  return parts.join('\n\n');
}

const SOURCE_EXT = /\.(go|js|jsx|ts|tsx|mjs|cjs)$/;
const TEST_NAME = /_test\.|\.test\./;
/** Keeps a bundle bounded; whole-package source is cut off at this many chars. */
export const PACKAGE_SOURCE_CAP = 120_000;

/**
 * Every source file directly in `dir` (not subdirectories) at `root`, minus the
 * file under test (already in the bundle). Production files come before test
 * files, so the cap drops test files first; a file that would overflow the cap
 * is skipped, not truncated.
 */
export function readPackageFiles(root: string, dir: string, exclude: string): { path: string; content: string }[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const names = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && SOURCE_EXT.test(e.name) && path.posix.join(dir, e.name) !== exclude)
    .map((e) => e.name)
    .sort((a, b) => Number(TEST_NAME.test(a)) - Number(TEST_NAME.test(b)) || a.localeCompare(b));
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const n of names) {
    const content = fs.readFileSync(path.join(abs, n), 'utf8');
    if (total + content.length > PACKAGE_SOURCE_CAP) continue;
    total += content.length;
    out.push({ path: path.posix.join(dir, n), content });
  }
  return out;
}
