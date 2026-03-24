import { ReviewFinding } from './api-client';

export interface DiffChunk {
  file: string;
  content: string;
}

export interface ValidationResult {
  validFindings: ReviewFinding[];
  hallucinatedFindings: ReviewFinding[];
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
        if (!line.startsWith('-')) {
          validLines.add(currentLine);
          currentLine++;
        }
      }
    }

    fileToValidLines.set(chunk.file, validLines);
  }

  for (const finding of findings) {
    if (!finding.fileName) {
      hallucinatedFindings.push(finding);
      continue;
    }
    
    let validLinesForFile: Set<number> | undefined;
    for (const [chunkFile, lines] of fileToValidLines.entries()) {
      const cleanFinding = finding.fileName.replace(/^\//, '').replace(/^[ab]\//, '');
      const cleanChunk = chunkFile.replace(/^\//, '').replace(/^[ab]\//, '');
      if (cleanFinding === cleanChunk || cleanFinding.endsWith(cleanChunk) || cleanChunk.endsWith(cleanFinding)) {
        validLinesForFile = lines;
        break;
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
