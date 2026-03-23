import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent, AnalyzeResult } from './types';
import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveryIssue {
  file: string;
  line: number;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  summary: string;
}

export class GeminiAgent implements Subagent {
  name: string;
  public promptContent: string;
  private ai: GoogleGenAI;

  constructor(name: string, promptContent: string) {
    this.name = name;
    this.promptContent = promptContent;
    // The SDK automatically picks up GOOGLE_APPLICATION_CREDENTIALS for ADC,
    // or GEMINI_API_KEY from the environment.
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 
  }

  async analyze(chunks: DiffChunk[]): Promise<AnalyzeResult> {
    if (process.env.USE_TRIAGE_AGENT === 'false') {
      const results = await Promise.all(chunks.map(chunk => this.analyzeLegacy(chunk)));
      return {
          findings: results.flatMap(r => r.findings),
          usage: {
              promptTokenCount: results.reduce((sum, r) => sum + (r.usage?.promptTokenCount || 0), 0),
              candidatesTokenCount: results.reduce((sum, r) => sum + (r.usage?.candidatesTokenCount || 0), 0),
              totalTokenCount: results.reduce((sum, r) => sum + (r.usage?.totalTokenCount || 0), 0)
          }
      };
    }

    const aggregatedFiles = `Aggregated PR (${chunks.length} files)`;
    let timeoutId: NodeJS.Timeout | undefined;
    let promptTokens = 0;
    let candidatesTokens = 0;

    try {
      console.log(`[${this.name}] Starting Pass 1 (Discovery) for ${aggregatedFiles}...`);
      
      const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '180000', 10);
      
      // We wrap the API call logic to support retrying dropped files
      let chunksToProcess = [...chunks];
      const maxRetries = 2;
      let retries = 0;
      let discoveryIssues: DiscoveryIssue[] = [];

      while (chunksToProcess.length > 0 && retries <= maxRetries) {
        const promptPayload = this.buildDiscoveryPrompt(chunksToProcess);
        
        const genAiRequest = this.ai.models.generateContent({
           model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
           contents: promptPayload.contents,
           config: {
             systemInstruction: promptPayload.systemInstruction,
             responseMimeType: 'application/json',
             responseSchema: {
               type: Type.OBJECT,
               description: "Strict coverage wrapper for code review.",
               properties: {
                 filesAnalyzed: {
                   type: Type.ARRAY,
                   description: "A complete list of EVERY file path that was successfully read and checked for bugs.",
                   items: { type: Type.STRING }
                 },
                 issues: {
                   type: Type.ARRAY,
                   description: "A list of problematic locations found in the code.",
                   items: {
                     type: Type.OBJECT,
                     properties: {
                       file: { type: Type.STRING },
                       line: { type: Type.INTEGER },
                       severity: { type: Type.STRING, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
                       summary: { type: Type.STRING }
                     },
                     required: ["file", "line", "severity", "summary"]
                   }
                 }
               },
               required: ["filesAnalyzed", "issues"]
             }
           }
        });

        const timeoutPromise = new Promise<any>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Gemini fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
        });

        const response = await Promise.race([genAiRequest, timeoutPromise]).finally(() => clearTimeout(timeoutId));
        
        if (response.usageMetadata) {
            promptTokens += response.usageMetadata.promptTokenCount || 0;
            candidatesTokens += response.usageMetadata.candidatesTokenCount || 0;
        }

        if (response.text) {
            const result = JSON.parse(response.text) as { filesAnalyzed: string[], issues: DiscoveryIssue[] };
            if (result.issues) {
                discoveryIssues.push(...result.issues);
            }
            
            // Strict Coverage Diffing Logic
            const analyzedSet = new Set(result.filesAnalyzed || []);
            const missedChunks = chunksToProcess.filter(c => !analyzedSet.has(c.file));
            
            if (missedChunks.length > 0) {
               console.warn(`[${this.name}] Pass 1 missed ${missedChunks.length} files. Retrying... (Attempt ${retries + 1}/${maxRetries})`);
               chunksToProcess = missedChunks;
               retries++;
            } else {
               chunksToProcess = []; // All files successfully processed
            }
        } else {
            break; // Unexpected empty response, break loop
        }
      }

      if (discoveryIssues.length === 0) {
          console.log(`[${this.name}] Pass 1 found 0 issues. Skipping Pass 2.`);
          return { findings: [], usage: { promptTokenCount: promptTokens, candidatesTokenCount: candidatesTokens, totalTokenCount: promptTokens + candidatesTokens } };
      }

      console.log(`[${this.name}] Starting Pass 2 (Remediation) for ${discoveryIssues.length} identified issues...`);

      // PASS 2: Remediation
      const remediationPayload = this.buildRemediationPrompt(chunks, discoveryIssues);
      const remediationRequest = this.ai.models.generateContent({
           model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
           contents: remediationPayload.contents,
           config: {
             systemInstruction: remediationPayload.systemInstruction,
             responseMimeType: 'application/json',
             responseSchema: {
               type: Type.ARRAY,
               description: "A final list of highly educational code review fixes for the provided issues.",
               items: {
                 type: Type.OBJECT,
                 properties: {
                   file: { type: Type.STRING },
                   line: { type: Type.INTEGER },
                   severity: { type: Type.STRING, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
                   summary: { type: Type.STRING },
                   description: { type: Type.STRING, description: "A highly educational explanation of why this is a flaw and how the architectural pattern works." },
                   suggestion: { type: Type.STRING, description: "A properly formatted multi-line Markdown code block demonstrating the exact fix." }
                 },
                 required: ["file", "line", "severity", "summary", "description", "suggestion"]
               }
             }
           }
      });

      const remediationResponse = await Promise.race([remediationRequest, new Promise<any>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Gemini remediation fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
      })]).finally(() => clearTimeout(timeoutId));

      if (remediationResponse.usageMetadata) {
          promptTokens += remediationResponse.usageMetadata.promptTokenCount || 0;
          candidatesTokens += remediationResponse.usageMetadata.candidatesTokenCount || 0;
      }

      if (remediationResponse.text) {
          const findings = JSON.parse(remediationResponse.text) as CandidateFinding[];
          console.log(`[${this.name}] Successfully generated ${findings.length} final actionable findings.`);
          return {
            findings: findings.map(f => ({ ...f, agent: this.name })),
            usage: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: candidatesTokens,
                totalTokenCount: promptTokens + candidatesTokens
            }
          };
      }
      return { findings: [] };

    } catch (e) {
      console.error(`⚠️ Note: The ${this.name} Agent failed to complete its review for ${aggregatedFiles}`, e);
      return { findings: [] };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async analyzeLegacy(chunk: DiffChunk): Promise<AnalyzeResult> {
    const prompt = `
<SYSTEM_INSTRUCTIONS>
${this.promptContent}
</SYSTEM_INSTRUCTIONS>

<FILE_PATH>
${chunk.file}
</FILE_PATH>

<DIFF_CONTENT>
${chunk.content}
</DIFF_CONTENT>
`;
    
    try {
      console.log(`[${this.name}] Starting Baseline Gemini API call for ${chunk.file}...`);
      
      const response = await this.ai.models.generateContent({
         model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           responseSchema: {
             type: Type.ARRAY,
             description: "A list of potential findings or issues found in the code diff based on the system instructions.",
             items: {
               type: Type.OBJECT,
               properties: {
                 file: { type: Type.STRING, description: "The path of the file being reviewed" },
                 line: { type: Type.INTEGER, description: "The starting line number of the issue in the diff" },
                 severity: { type: Type.STRING, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"], description: "The severity of the issue" },
                 summary: { type: Type.STRING, description: "A single sentence summary of the issue" },
                 description: { type: Type.STRING, description: "More details about the issue, including why it is an issue" },
                 suggestion: { type: Type.STRING, nullable: true, description: "An optional code snippet demonstrating how to fix the issue." }
               },
               required: ["file", "line", "severity", "summary", "description"]
             }
           }
         }
      });

      if (response.text) {
          const findings = JSON.parse(response.text) as CandidateFinding[];
          return {
            findings: findings.map(f => ({ ...f, file: chunk.file, agent: this.name })),
            usage: response.usageMetadata ? {
                promptTokenCount: response.usageMetadata.promptTokenCount || 0,
                candidatesTokenCount: response.usageMetadata.candidatesTokenCount || 0,
                totalTokenCount: response.usageMetadata.totalTokenCount || 0
            } : undefined
          };
      }
      return { findings: [] };
    } catch (e) {
      console.error(`⚠️ Note: The ${this.name} Agent failed to complete its baseline review for ${chunk.file}`, e);
      return { findings: [] };
    }
  }

  private buildDiscoveryPrompt(chunks: DiffChunk[]): { systemInstruction: string, contents: string } {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    const systemInstruction = `You are the ${this.name} discovery agent.
Your ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.
Ensure you return your response in the strictly required JSON format.
CRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it. 
If you skip a file, the system will fail.
${this.promptContent}`;

    const contents = `<DIFF_CONTENTS>\n${diffsText}\n</DIFF_CONTENTS>`;
    return { systemInstruction, contents };
  }

  private buildRemediationPrompt(chunks: DiffChunk[], issues: DiscoveryIssue[]): { systemInstruction: string, contents: string } {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    const issuesText = JSON.stringify(issues, null, 2);
    const systemInstruction = `You are an elite, highly educational Staff Engineer acting as the ${this.name} remediation agent.
A junior system has already flagged the potential issues in the following JSON array.
Your job is to read these flagged locations, read the source code context, and synthesize a masterful, highly detailed, and educational explanation for each issue.
Most importantly, you MUST provide a complete, copy-pasteable markdown code block in the \`suggestion\` field showing exactly how the developers should rewrite the code to adhere to best architectural practices.
Your descriptions must elevate from simple linting to deep mentorship and architectural guidance.
${this.promptContent}`;

    const contents = `<FLAGGED_ISSUES>\n${issuesText}\n</FLAGGED_ISSUES>\n\n<DIFF_CONTENTS>\n${diffsText}\n</DIFF_CONTENTS>`;
    return { systemInstruction, contents };
  }
}
