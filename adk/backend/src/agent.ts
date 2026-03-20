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
    const prompt = this.buildPrompt(chunks);
    const aggregatedFiles = `Aggregated PR (${chunks.length} files)`;
    let timeoutId: NodeJS.Timeout | undefined;
    
    try {
      console.log(`[${this.name}] Starting Gemini API call for ${aggregatedFiles}...`);
      
      const genAiRequest = this.ai.models.generateContent({
         model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           responseSchema: {
             type: Type.ARRAY,
             description: "A list of potential findings or issues found in the code diffs based on the system instructions.",
             items: {
               type: Type.OBJECT,
               properties: {
                 file: { type: Type.STRING, description: "The path of the file where the issue was found" },
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
      
      // Enforce a strict network timeout to accommodate large monolithic reviews.
      const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '180000', 10);
      const timeoutPromise = new Promise<any>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Gemini fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
      });

      const response = await Promise.race([genAiRequest, timeoutPromise]);
      
      console.log(`[${this.name}] Received Gemini API response for ${aggregatedFiles}`);

      if (response.text) {
          const findings = JSON.parse(response.text) as CandidateFinding[];
          return {
            findings: findings.map(f => ({ ...f, agent: this.name })), // Trust Gemini's generated 'file' field
            usage: response.usageMetadata ? {
                promptTokenCount: response.usageMetadata.promptTokenCount || 0,
                candidatesTokenCount: response.usageMetadata.candidatesTokenCount || 0,
                totalTokenCount: response.usageMetadata.totalTokenCount || 0
            } : undefined
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

  private buildPrompt(chunks: DiffChunk[]): string {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    return `
<SYSTEM_INSTRUCTIONS>
${this.promptContent || `You are the ${this.name} agent. Review the following code diff.`}
</SYSTEM_INSTRUCTIONS>

<DIFF_CONTENTS>
${diffsText}
</DIFF_CONTENTS>
`;
  }
}
