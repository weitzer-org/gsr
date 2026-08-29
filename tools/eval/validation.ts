import { ReviewFinding } from './api-client';

export interface DiffChunk {
  file: string;
  content: string;
}

export interface ValidationResult {
  validFindings: ReviewFinding[];
  hallucinatedFindings: ReviewFinding[];
}

export interface RecallResult {
  recoveredCount: number;
  totalReference: number;
  recallFraction: number;
  missedFindings: ReviewFinding[];
}

/**
 * Deterministic recall proxy: what fraction of `referenceFindings` (e.g. the
 * baseline model's findings) does `candidateFindings` also cover?
 *
 * The judge's actionability score rates the quality of what a target found,
 * not whether it found enough — a target that goes silent on a 15-file PR
 * scores fine on actionability for its (empty) output. This computes a
 * proximity match (same file, within `proximityLines` lines — the same
 * "same or nearby lines" convention the deduplicator's own grouping prompt
 * uses to treat findings as one issue) so a real coverage gap shows up
 * independent of the judge, and independent of any extra LLM calls — this
 * runs entirely on findings the harness has already fetched.
 */
export function computeRecall(
  candidateFindings: ReviewFinding[],
  referenceFindings: ReviewFinding[],
  proximityLines = 10
): RecallResult {
  const recovered: ReviewFinding[] = [];
  const missedFindings: ReviewFinding[] = [];
  // 1:1 greedy matching — a candidate finding, once matched, can't also
  // "recover" a second nearby reference finding. The original `.some()`
  // check let one candidate finding count as covering every reference
  // finding within its proximity window, which silently inflated recall most
  // in exactly the regime under study: a candidate with very few findings
  // scattered across a large file.
  const consumed = new Set<number>();

  for (const ref of referenceFindings) {
    const matchIndex = candidateFindings.findIndex((c, i) =>
      !consumed.has(i) &&
      filePathsMatch(c.fileName || '', ref.fileName || '') &&
      Math.abs((c.lineNumber || 0) - (ref.lineNumber || 0)) <= proximityLines
    );
    if (matchIndex !== -1) {
      consumed.add(matchIndex);
      recovered.push(ref);
    } else {
      missedFindings.push(ref);
    }
  }

  const totalReference = referenceFindings.length;
  return {
    recoveredCount: recovered.length,
    totalReference,
    recallFraction: totalReference > 0 ? recovered.length / totalReference : 1,
    missedFindings,
  };
}

/** Strips a leading '/' and a git-style 'a/'/'b/' diff prefix from a file path. */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/^\//, '').replace(/^[ab]\//, '');
}

/** Same-file check tolerant of one side being a path suffix of the other, given two already-normalized paths. */
function pathsMatchNormalized(na: string, nb: string): boolean {
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/** Same-file check tolerant of one side being a path suffix of the other (e.g. relative vs repo-rooted). Normalizes both inputs — pass already-normalized paths to pathsMatchNormalized instead to avoid double-normalizing. */
export function filePathsMatch(a: string, b: string): boolean {
  return pathsMatchNormalized(normalizeFilePath(a), normalizeFilePath(b));
}

export function validateFindingsAgainstDiff(findings: ReviewFinding[], diffChunks: DiffChunk[]): ValidationResult {
  const validFindings: ReviewFinding[] = [];
  const hallucinatedFindings: ReviewFinding[] = [];

  // Build a map of valid file names and their associated valid line numbers
  const fileToValidLines = new Map<string, Set<number>>();

  for (const chunk of diffChunks) {
    const validLines = new Set<number>();
    
    // Parse unified diff patch to extract line numbers
    // Hunk header: @@ -old_line,old_count +new_line,new_count @@
    const lines = chunk.content.split('\n');
    let currentLine = -1;

    for (const line of lines) {
      if (line.startsWith('@@ ')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentLine = parseInt(match[1], 10);
        }
      } else if (currentLine > 0 && !line.startsWith('\\ No newline')) {
        if (line.startsWith('+')) {
          validLines.add(currentLine);
          currentLine++;
        } else if (line.startsWith(' ')) {
          // Context lines advance the counter but are not valid locations for new findings
          currentLine++;
        }
      }
    }

    fileToValidLines.set(normalizeFilePath(chunk.file), validLines);
  }

  for (const finding of findings) {
    if (!finding.fileName) {
      hallucinatedFindings.push(finding);
      continue;
    }
    
    let validLinesForFile: Set<number> | undefined;
    const cleanFinding = normalizeFilePath(finding.fileName);

    // O(1) primary lookup
    validLinesForFile = fileToValidLines.get(cleanFinding);

    // Structural fallback lookup with boundary bounds.
    // cleanFinding and the map's keys are already normalized here, so use
    // pathsMatchNormalized directly rather than filePathsMatch — routing
    // through filePathsMatch would re-normalize already-normalized paths,
    // incorrectly stripping a second leading 'a/'/'b/' segment from paths
    // where that's a real directory name.
    if (!validLinesForFile) {
        for (const [cleanChunk, lines] of fileToValidLines.entries()) {
            if (pathsMatchNormalized(cleanFinding, cleanChunk)) {
                validLinesForFile = lines;
                break;
            }
        }
    }
    
    if (!validLinesForFile) {
      // File not found in diff
      hallucinatedFindings.push(finding);
      continue;
    }

    if (!validLinesForFile.has(finding.lineNumber)) {
      // Line number not found in the valid ranges
      hallucinatedFindings.push(finding);
      continue;
    }

    validFindings.push(finding);
  }

  return { validFindings, hallucinatedFindings };
}
