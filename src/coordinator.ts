import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { CandidateFinding, DiffChunk, GSRConfig, Subagent } from './types';
import { PromisePool } from './pool';

export class Coordinator {
  private config: GSRConfig;
  private subagents: Subagent[] = [];

  constructor() {
    this.config = this.loadConfig();
  }

  public registerAgent(agent: Subagent) {
    this.subagents.push(agent);
  }

  private loadConfig(): GSRConfig {
    const configPath = path.join(process.cwd(), 'gemini-review.yaml');
    if (fs.existsSync(configPath)) {
      const file = fs.readFileSync(configPath, 'utf8');
      return yaml.parse(file) as GSRConfig;
    }

    // Default configuration if file is missing
    return {
      review_settings: {
        min_severity: "Low",
        max_concurrency: 3,
      },
      subagents: [],
    };
  }

  /**
   * Shells out to git to get the unified diff of local changes or compared to a branch.
   */
  private getGitDiff(targetBranch: string = 'origin/HEAD'): string {
    try {
      // Get uncommitted changes first
      let diff = execSync('git diff -U5 HEAD').toString();
      
      // If no uncommitted changes, check against the target branch
      if (!diff) {
        diff = execSync(`git diff -U5 --merge-base ${targetBranch}`).toString();
      }
      return diff;
    } catch (e) {
      console.error("Failed to execute git diff. Ensure you are in a git repository.", e);
      return "";
    }
  }

  /**
   * Parses a raw unified git diff into an array of file-specific DiffChunks
   */
  private parseDiff(rawDiff: string): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    const files = rawDiff.split(/^diff --git a\/(.+?) b\/(.+?)$/m);
    
    // The split returns: [ preamble, filename_a, filename_b, file_diff_content, ... ]
    for (let i = 1; i < files.length; i += 3) {
      const filename = files[i];
      const content = files[i + 2].trim();
      if (filename && content) {
        chunks.push({
          file: filename,
          content: content
        });
      }
    }
    return chunks;
  }

  /**
   * The main entry point to run the review
   */
  public async runReview(): Promise<CandidateFinding[]> {
    const rawDiff = this.getGitDiff();
    if (!rawDiff) {
        console.log("No changes detected.");
        return [];
    }

    const chunks = this.parseDiff(rawDiff);
    const pool = new PromisePool(this.config.review_settings.max_concurrency || 3);
    const allFindings: CandidateFinding[] = [];

    // Map Tasks based on routing rules
    const tasks: (() => Promise<CandidateFinding[]>)[] = [];

    for (const chunk of chunks) {
      for (const agentConfig of this.config.subagents) {
        if (!agentConfig.enabled) continue;
        
        const agent = this.subagents.find(a => a.name.toLowerCase() === agentConfig.name.toLowerCase());
        if (agent) {
          // In a real implementation, we would evaluate `agentConfig.paths` glob matching here.
          // For now, we assume if the agent is enabled, it gets the chunk (for MVP).
          tasks.push(async () => {
             return agent.analyze(chunk);
          });
        }
      }
    }

    // Execute concurrently using the bounded promise pool
    console.log(`Routing ${chunks.length} files to ${tasks.length} subagent analysis tasks (Max Concurrency: ${this.config.review_settings.max_concurrency})...`);
    
    const results = await Promise.all(tasks.map(t => pool.add(t)));
    
    // Flatten findings
    for (const result of results) {
        allFindings.push(...result);
    }

    // Filter by min severity
    return this.filterFindings(allFindings);
  }

  private filterFindings(findings: CandidateFinding[]): CandidateFinding[] {
      const severityScores: Record<string, number> = { "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4 };
      const minScore = severityScores[this.config.review_settings.min_severity.toUpperCase()] || 1;

      return findings.filter(f => {
          const score = severityScores[f.severity.toUpperCase()] || 0;
          return score >= minScore;
      });
  }
}
