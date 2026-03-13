import { CandidateFinding, DiffChunk, Subagent } from './types';
import { GeminiAgent } from './agent';
import { PromisePool } from './pool';

export class Orchestrator {
  private subagents: Subagent[] = [];
  private maxConcurrency: number;
  public onProgress?: (agentName: string, file: string, status: 'start' | 'complete') => void;

  constructor(maxConcurrency: number = 5) {
    this.maxConcurrency = maxConcurrency;
    this.initializeAgents();
  }

  private initializeAgents() {
    this.subagents = [
      new GeminiAgent('Logic', 'logic.md')
    ];
  }

  public async runReview(chunks: DiffChunk[]): Promise<CandidateFinding[]> {
    if (!chunks || chunks.length === 0) {
        return [];
    }

    const pool = new PromisePool(this.maxConcurrency);
    const allFindings: CandidateFinding[] = [];

    // Map Tasks based on routing rules
    const tasks: (() => Promise<CandidateFinding[]>)[] = [];

    for (const chunk of chunks) {
      for (const agent of this.subagents) {
        tasks.push(async () => {
            if (this.onProgress) {
                this.onProgress(agent.name, chunk.file, 'start');
            }
            try {
                const res = await agent.analyze(chunk);
                if (this.onProgress) {
                    this.onProgress(agent.name, chunk.file, 'complete');
                }
                return res;
            } catch (err) {
                if (this.onProgress) {
                    this.onProgress(agent.name, chunk.file, 'complete');
                }
                throw err;
            }
        });
      }
    }

    console.log(`Orchestrator routing ${chunks.length} files to ${tasks.length} subagent analysis tasks...`);
    
    const results = await Promise.all(tasks.map(t => pool.add(t)));
    
    // Flatten findings
    for (const result of results) {
        allFindings.push(...result);
    }

    // Filter out low severity by default to avoid noise in the UI
    return this.filterFindings(allFindings, "Low");
  }

  private filterFindings(findings: CandidateFinding[], minSeverity: string): CandidateFinding[] {
      const severityScores: Record<string, number> = { "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4 };
      const minScore = severityScores[minSeverity.toUpperCase()] || 1;

      return findings.filter(f => {
          const score = severityScores[f.severity.toUpperCase()] || 0;
          return score >= minScore;
      });
  }
}
