import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent, AnalyzeResult } from './types';
import { trackGeminiCall, recordParseFailure } from './usage';
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
  private cachedContentName?: string;

  constructor(name: string, promptContent: string) {
    this.name = name;
    this.promptContent = promptContent;
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

    const useContextCaching = process.env.USE_CONTEXT_CACHING !== 'false';

    if (useContextCaching && !this.cachedContentName) {
      try {
        console.log(`[${this.name}] Initializing Context Cache for persona...`);
        // Note: GoogleGenAI caches.create defaults exactly
        const discoverySystemInstruction = `You are the ${this.name} discovery agent.\nYour ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.\nEnsure you return your response in the strictly required JSON format.\nCRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it. \nIf you skip a file, the system will fail.\n${this.promptContent}`;
        
        const envModel = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
        const cacheModel = envModel.startsWith('models/') ? envModel : `models/${envModel}`;
        
        const tokenResponse = await this.ai.models.countTokens({
           model: envModel,
           contents: discoverySystemInstruction,
        });

        const CONTEXT_CACHE_TOKEN_THRESHOLD = 2048;
        const tokenTotal = tokenResponse.totalTokens || 0;
        if (tokenTotal < CONTEXT_CACHE_TOKEN_THRESHOLD) {
           console.log(`[${this.name}] Bypassing Context Cache (instructions size ${tokenTotal} is under the ${CONTEXT_CACHE_TOKEN_THRESHOLD} token limit).`);
        } else {
           const cache = await this.ai.caches.create({
             model: cacheModel,
             config: {
                systemInstruction: discoverySystemInstruction,
                ttl: '3600s'
             }
           });
           this.cachedContentName = cache.name;
           console.log(`[${this.name}] Cache created successfully: ${cache.name}`);
        }
      } catch (e) {
        console.warn(`[${this.name}] Failed to create Context Cache, falling back to un-cached:`, e);
      }
    }

    try {
      console.log(`[${this.name}] Starting Pass 1 (Discovery) for ${aggregatedFiles}...`);
      
      // 300000 (5min) matches deduplicator.ts's default — aggregateChunks
      // (review-quality-design.md §5.1) means this discovery/remediation
      // call can now cover a whole PR's worth of files in one request, and
      // 180000 was timing out outright on PRs as small as 13-15 files,
      // returning zero findings for the push instead of a partial result.
      // Node's setTimeout treats NaN, <=0, and anything above the 32-bit
      // signed int max (2147483647) identically: it clamps to ~1ms and
      // fires almost immediately (verified empirically — see the PR
      // description) — so every discovery/remediation call would "time
      // out" instantly under any of those GEMINI_TIMEOUT_MS values. Fall
      // back to the same 300000 default the rest of the app uses.
      const rawTimeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '300000', 10);
      const timeoutMs = Number.isNaN(rawTimeoutMs) || rawTimeoutMs <= 0 || rawTimeoutMs > 2147483647 ? 300000 : rawTimeoutMs;

      // We wrap the API call logic to support retrying dropped files
      let chunksToProcess = [...chunks];
      const maxRetries = 2;
      let retries = 0;
      let discoveryIssues: DiscoveryIssue[] = [];

      while (chunksToProcess.length > 0 && retries <= maxRetries) {
        const promptPayload = this.buildDiscoveryPrompt(chunksToProcess);
        
        const requestArgs: any = {
           model: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
           contents: promptPayload.contents,
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
        };

        if (useContextCaching && this.cachedContentName) {
           requestArgs.cachedContent = this.cachedContentName;
           // The cachedContent implies systemInstruction is fulfilled natively
        } else {
           requestArgs.config.systemInstruction = promptPayload.systemInstruction;
        }

        const discoveryRequestStart = Date.now();
        const genAiRequest = trackGeminiCall(
          { callType: 'discovery', model: requestArgs.model },
          () => this.ai.models.generateContent(requestArgs)
        );

        const timeoutPromise = new Promise<any>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Gemini fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
        });

        const response = await Promise.race([genAiRequest, timeoutPromise]).finally(() => clearTimeout(timeoutId));

        if (response.usageMetadata) {
            promptTokens += response.usageMetadata.promptTokenCount || 0;
            candidatesTokens += response.usageMetadata.candidatesTokenCount || 0;
        }

        if (response.text) {
            let result: { filesAnalyzed: string[], issues: DiscoveryIssue[] };
            try {
              result = JSON.parse(response.text);
            } catch (parseErr) {
              // The call succeeded and was billed (trackGeminiCall already
              // recorded that) but the response can't be used — previously
              // this thrown error was caught by analyze()'s outer catch and
              // turned into a silent `{ findings: [] }`, indistinguishable
              // from "found nothing". Record it as its own visible failure
              // mode before letting that same graceful-degradation path run.
              await recordParseFailure({ callType: 'discovery', model: requestArgs.model }, response, Date.now() - discoveryRequestStart);
              throw parseErr;
            }
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
      // Not cached because it uses a different short-lived prompt focused tightly on synthesizing solutions
      const remediationPayload = this.buildRemediationPrompt(chunks, discoveryIssues);
      const remediationModel = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
      const remediationRequestStart = Date.now();
      const remediationRequest = trackGeminiCall(
        { callType: 'remediation', model: remediationModel },
        () => this.ai.models.generateContent({
           model: remediationModel,
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
        })
      );

      const remediationResponse = await Promise.race([remediationRequest, new Promise<any>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Gemini remediation fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
      })]).finally(() => clearTimeout(timeoutId));

      if (remediationResponse.usageMetadata) {
          promptTokens += remediationResponse.usageMetadata.promptTokenCount || 0;
          candidatesTokens += remediationResponse.usageMetadata.candidatesTokenCount || 0;
      }

      if (remediationResponse.text) {
          let findings: CandidateFinding[];
          try {
            findings = JSON.parse(remediationResponse.text);
          } catch (parseErr) {
            await recordParseFailure({ callType: 'remediation', model: remediationModel }, remediationResponse, Date.now() - remediationRequestStart);
            throw parseErr;
          }
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
      return { findings: [], usage: { promptTokenCount: promptTokens, candidatesTokenCount: candidatesTokens, totalTokenCount: promptTokens + candidatesTokens } };

    } catch (e) {
      console.error(`⚠️ Note: The ${this.name} Agent failed to complete its review for ${aggregatedFiles}`, e);
      // Preserve whatever was actually spent before the failure (e.g. a
      // successful Pass 1, then a Pass 2 timeout) — previously this
      // discarded that accounting entirely. The real per-call cost is still
      // in the S3 usage records regardless (trackGeminiCall writes those
      // independently); this only affects what this function itself returns.
      return { findings: [], usage: { promptTokenCount: promptTokens, candidatesTokenCount: candidatesTokens, totalTokenCount: promptTokens + candidatesTokens } };
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
      
      const legacyModel = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
      const legacyRequestStart = Date.now();
      const response = await trackGeminiCall(
        { callType: 'legacy', model: legacyModel },
        () => this.ai.models.generateContent({
         model: legacyModel,
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
        })
      );

      if (response.text) {
          let findings: CandidateFinding[];
          try {
            findings = JSON.parse(response.text);
          } catch (parseErr) {
            await recordParseFailure({ callType: 'legacy', model: legacyModel }, response, Date.now() - legacyRequestStart);
            throw parseErr;
          }
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
    const systemInstruction = `You are the ${this.name} discovery agent.\nYour ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.\nEnsure you return your response in the strictly required JSON format.\nCRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it. \nIf you skip a file, the system will fail.\n${this.promptContent}`;

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
