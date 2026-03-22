import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent, AnalyzeResult } from './types';
import * as fs from 'fs';
import * as path from 'path';

export class GeminiAgent implements Subagent {
  name: string;
  private promptContent: string;
  private ai: GoogleGenAI;

  constructor(name: string, promptContent: string) {
    this.name = name;
    this.promptContent = promptContent;
    // The SDK automatically picks up GOOGLE_APPLICATION_CREDENTIALS for ADC,
    // or GEMINI_API_KEY from the environment.
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 
  }

  async analyze(chunks: DiffChunk[]): Promise<AnalyzeResult> {
    const aggregatedFiles = `Aggregated PR (${chunks.length} files)`;
    let timeoutId: NodeJS.Timeout | undefined;
    let finalFindings: CandidateFinding[] = [];
    let promptTokens = 0;
    let candidatesTokens = 0;

    try {
      console.log(`[${this.name}] Starting Pass 1 (Discovery) for ${aggregatedFiles}...`);
      
      const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '180000', 10);
      
      // We wrap the API call logic to support retrying dropped files
      let chunksToProcess = [...chunks];
      const maxRetries = 2;
      let retries = 0;
      let discoveryIssues: any[] = [];

      while (chunksToProcess.length > 0 && retries <= maxRetries) {
        const prompt = this.buildDiscoveryPrompt(chunksToProcess);
        
        const genAiRequest = this.ai.models.generateContent({
           model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
           contents: prompt,
           config: {
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

        const response = await Promise.race([genAiRequest, timeoutPromise]);
        
        if (response.usageMetadata) {
            promptTokens += response.usageMetadata.promptTokenCount || 0;
            candidatesTokens += response.usageMetadata.candidatesTokenCount || 0;
        }

        if (response.text) {
            const result = JSON.parse(response.text) as { filesAnalyzed: string[], issues: any[] };
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
      const remediationPrompt = this.buildRemediationPrompt(chunks, discoveryIssues);
      const remediationRequest = this.ai.models.generateContent({
           model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
           contents: remediationPrompt,
           config: {
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
      })]);

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

  private buildDiscoveryPrompt(chunks: DiffChunk[]): string {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    return `
<SYSTEM_INSTRUCTIONS>
You are the ${this.name} discovery agent.
Your ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.
Ensure you return your response in the strictly required JSON format.
CRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it. 
If you skip a file, the system will fail.
${this.promptContent}
</SYSTEM_INSTRUCTIONS>

<DIFF_CONTENTS>
${diffsText}
</DIFF_CONTENTS>
`;
  }

  private buildRemediationPrompt(chunks: DiffChunk[], issues: any[]): string {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    const issuesText = JSON.stringify(issues, null, 2);
    return `
<SYSTEM_INSTRUCTIONS>
You are an elite, highly educational Staff Engineer acting as the ${this.name} remediation agent.
A junior system has already flagged the potential issues in the following JSON array.
Your job is to read these flagged locations, read the source code context, and synthesize a masterful, highly detailed, and educational explanation for each issue.
Most importantly, you MUST provide a complete, copy-pasteable markdown code block in the \`suggestion\` field showing exactly how the developers should rewrite the code to adhere to best architectural practices.
Your descriptions must elevate from simple linting to deep mentorship and architectural guidance.
${this.promptContent}
</SYSTEM_INSTRUCTIONS>

<FLAGGED_ISSUES>
${issuesText}
</FLAGGED_ISSUES>

<DIFF_CONTENTS>
${diffsText}
</DIFF_CONTENTS>
`;
  }
}
