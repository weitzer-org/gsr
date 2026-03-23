import { CandidateFinding, DiffChunk, Subagent, ReviewResult, AnalyzeResult } from './types';
import { GeminiAgent } from './agent';
import { DeduplicatorAgent } from './deduplicator';
import { PromisePool } from './pool';
import * as fs from 'fs';
import * as path from 'path';

export class Orchestrator {
  private subagents: Subagent[] = [];
  private maxConcurrency: number;
  public onProgress?: (agentName: string, file: string, status: 'start' | 'complete' | 'skipped') => void;

  private promptsDirName: string;
  private deduplicator: DeduplicatorAgent;
  private useTriage: boolean; // Keeping the parameter name for backwards compatibility, but it refers to grouping logic now

  constructor(maxConcurrency: number = 5, promptsDirName: string = 'system_prompts', useTriage: boolean = true) {
    this.maxConcurrency = maxConcurrency;
    this.promptsDirName = path.basename(promptsDirName);
    this.deduplicator = new DeduplicatorAgent();
    this.useTriage = useTriage;
    this.initializeAgents();
  }

  private initializeAgents() {
    const currentDir = typeof __dirname !== 'undefined' ? __dirname : undefined;
    let projectRoot: string;

    if (currentDir) {
        const isCompiled = currentDir.includes(path.join('dist', 'src'));
        projectRoot = isCompiled 
            ? path.resolve(currentDir, '../../../../') 
            : path.resolve(currentDir, '../../../');
    } else {
        // Fallback for test environments (e.g. Jest ESM mode)
        projectRoot = path.resolve(process.cwd(), '../../');
    }
    const promptsDir = path.join(projectRoot, 'gemini-cli-extension', this.promptsDirName);

    try {
      const files = fs.readdirSync(promptsDir);

      this.subagents = files
        .filter((f: string) => f.endsWith('.md'))
        .map((f: string) => {
            const name = f.replace('.md', '');
            // Capitalize for user display
            const displayName = name.charAt(0).toUpperCase() + name.slice(1);
            const promptPath = path.join(promptsDir, f);
            let promptContent = '';
            try {
              promptContent = fs.readFileSync(promptPath, 'utf8');
            } catch (e) {
              console.error(`Could not read prompt file for ${displayName}: ${promptPath}`);
            }
            return new GeminiAgent(displayName, promptContent);
        });
      console.log(`Loaded ${this.subagents.length} agents from ${promptsDir}`);
    } catch (e) {
      console.error("Failed to load subagents from prompts directory: " + promptsDir, e);
      this.subagents = [new GeminiAgent('Logic', 'You are the Logic agent. Review the following code diff.')];
    }
  }

  private shouldRun(agentName: string, file: string): boolean {
    const name = agentName.toLowerCase();
    
    const rules: Record<string, (file: string) => boolean> = {
      'cicd': (f) => f.includes('.github/workflows/') || f.includes('Dockerfile') || f.includes('Jenkinsfile') || f.includes('.gitlab-ci.yml'),
      'dependencies': (f) => f.includes('package.json') || f.includes('package-lock.json') || f.includes('requirements.txt') || f.includes('Gemfile') || f.includes('pom.xml') || f.includes('build.gradle'),
      'secrets': (f) => f.includes('.env') || f.includes('credentials') || f.includes('config') || f.endsWith('.key') || f.endsWith('.pem'),
      'promptsecurity': (f) => f.includes('prompts') || f.includes('templates')
    };

    if (rules[name]) {
        return rules[name](file);
    }
    return true;
  }

  public async runReview(chunks: DiffChunk[]): Promise<ReviewResult> {
    if (!chunks || chunks.length === 0) {
        return { findings: [], metrics: { inputTokens: 0, outputTokens: 0, calls: 0 } };
    }

    const pool = new PromisePool(this.maxConcurrency);
    const allFindings: CandidateFinding[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Map Tasks based on routing rules
    const tasks: (() => Promise<AnalyzeResult>)[] = [];

    if (this.useTriage) {
      // Execute all active GeminiAgents on their relevant DiffChunks based strictly on static filtering context for the deduplicator architecture
      for (const agent of this.subagents) {
        const activeChunks = chunks.filter(chunk => {
          let shouldInclude = this.shouldRun(agent.name, chunk.file);

          if (!shouldInclude) {
            if (this.onProgress) {
               this.onProgress(agent.name, chunk.file, 'skipped');
            }
            return false;
          }
          return true;
        });

        if (activeChunks.length === 0) {
          continue;
        }

        tasks.push(async () => {
            const progressFileName = `Aggregated PR (${activeChunks.length} files)`;
            if (this.onProgress) {
                this.onProgress(agent.name, progressFileName, 'start');
            }
            try {
                const res = await agent.analyze(activeChunks);
                if (this.onProgress) {
                    this.onProgress(agent.name, progressFileName, 'complete');
                }
                return res;
            } catch (err) {
                if (this.onProgress) {
                    this.onProgress(agent.name, progressFileName, 'complete');
                }
                throw err;
            }
        });
      }
    } else {
      // Legacy fallback: File-by-File routing
      for (const chunk of chunks) {
         for (const agent of this.subagents) {
            if (!this.shouldRun(agent.name, chunk.file)) {
                if (this.onProgress) {
                    this.onProgress(agent.name, chunk.file, 'skipped');
                }
                continue;
            }

            tasks.push(async () => {
                if (this.onProgress) {
                    this.onProgress(agent.name, chunk.file, 'start');
                }
                try {
                    const res = await agent.analyze([chunk]);
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
    }

    console.log(`Orchestrator mapped ${chunks.length} files to ${tasks.length} subagent analysis tasks...`);
    
    const results = await Promise.all(tasks.map(t => pool.add(t)));
    
    // Flatten findings and accumulate metrics
    for (const result of results) {
        if (result.findings) {
            allFindings.push(...result.findings);
        }
        if (result.usage) {
            totalInputTokens += result.usage.promptTokenCount || 0;
            totalOutputTokens += result.usage.candidatesTokenCount || 0;
        }
    }

    // Pass all concatenated CandidateFinding results to the new DeduplicatorAgent
    let deduplicatedFindings = allFindings;
    let triageCalls = 0;
    
    if (this.useTriage && allFindings.length > 0) {
        deduplicatedFindings = await this.deduplicator.deduplicate(allFindings);
        triageCalls = 1; // It acts as the routing/filtering step
    }

    // Filter out low severity by default to avoid noise in the UI
    const filteredFindings = this.filterFindings(deduplicatedFindings, "Low");
    
    return {
      findings: filteredFindings,
      metrics: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        calls: results.length + triageCalls
      }
    };
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
