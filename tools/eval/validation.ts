import { ReviewFinding } from './api-client';

export interface DiffChunk {
  file: string;
  content: string;
}

export interface ValidationResult {
  validFindings: ReviewFinding[];
  hallucinatedFindings: ReviewFinding[];
}

/** Strips a leading '/' and a git-style 'a/'/'b/' diff prefix from a file path. */
export function normalizeFilePath(filePath: string): string {
  return filePath.replace(/^\//, '').replace(/^[ab]\//, '');
}

/** Same-file check tolerant of one side being a path suffix of the other (e.g. relative vs repo-rooted). */
export function filePathsMatch(a: string, b: string): boolean {
  const na = normalizeFilePath(a);
  const nb = normalizeFilePath(b);
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
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

    // Structural fallback lookup with boundary bounds
    if (!validLinesForFile) {
        for (const [cleanChunk, lines] of fileToValidLines.entries()) {
            if (filePathsMatch(cleanFinding, cleanChunk)) {
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
