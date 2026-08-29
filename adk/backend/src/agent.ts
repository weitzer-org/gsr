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

// selectModel routes by PR size: a model comparison investigation found
// gemini-3.7-flash (and other flash-tier candidates) collapse to a fraction
// of gemini-3.1-pro-preview's finding volume specifically on large,
// multi-file PRs, while matching it exactly on small single-issue PRs. Below
// GEMINI_LARGE_PR_FILE_THRESHOLD, GEMINI_MODEL is used as configured (the
// case where a cheaper model has already been proven equivalent). At or
// above it, GEMINI_MODEL_LARGE_PR is used if set — otherwise falls back to
// GEMINI_MODEL, i.e. today's unconditional behavior. This captures most of a
// cheaper model's savings with zero quality risk on exactly the cases where
// the gap is real, without waiting on (or instead of) a prompt/architecture
// fix closing that gap directly.
export function selectModel(fileCount: number): string {
  const defaultModel = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
  const threshold = parseInt(process.env.GEMINI_LARGE_PR_FILE_THRESHOLD || '0', 10);
  const largeModel = process.env.GEMINI_MODEL_LARGE_PR;
  if (threshold > 0 && largeModel && fileCount >= threshold) {
    return largeModel;
  }
  return defaultModel;
}

// chunkArray splits chunks into DISCOVERY_FOCUS_WINDOW-sized groups for
// focus-window batching (see buildDiscoveryPrompt's focusChunks param).
function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
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

  // Single source of truth for the discovery system instruction — it was
  // previously duplicated between the context-cache creation path and
  // buildDiscoveryPrompt(), which only matters at all once the cache
  // threshold (2048 tokens) is crossed; below it the cache is bypassed and
  // the two copies are silently never compared. A future edit to just one
  // copy would make cached and uncached runs use different prompts with no
  // error — the eval harness's A/B comparisons would then be silently
  // comparing two different things. One method removes that risk entirely.
  //
  // Diagnostic evidence (per-model discovery-call output token volume,
  // gathered while investigating a Gemini-model-comparison recall gap)
  // pointed at Pass 1 (discovery) as the primary source of under-reporting,
  // not Pass 2 (remediation): flash-tier candidates converted far fewer
  // discovery calls into any remediation call at all (~42-43% vs baseline's
  // 67%), meaning they were finding nothing to report in the first pass far
  // more often, not just pruning more after the fact. The COVERAGE and
  // RECALL OVER PRECISION blocks below target that directly. The original
  // instruction gave no guidance on where the precision/recall dial should
  // sit, so each model used its own default — evidently tighter for
  // gemini-3.6-flash/3.7-flash than for gemini-3.1-pro-preview.
  private buildDiscoverySystemInstruction(): string {
    return `You are the ${this.name} discovery agent.
Your ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.
Ensure you return your response in the strictly required JSON format.

CRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it.
If you skip a file, the system will fail.

COVERAGE: Work through the files in <DIFF_CONTENTS> one at a time, in the order given. Do not stop early — the last file in the list must receive the same scrutiny as the first. Before emitting your answer, confirm that every file you list in \`filesAnalyzed\` was actually examined for issues in your specialty, not merely listed.

RECALL OVER PRECISION: This is a discovery pass, not a final report. A separate downstream stage verifies, elaborates on, and merges everything you flag, and a human reviews the result. Report every location you have reasonable suspicion about, not only the ones you are certain about. Under-reporting costs this system more than over-reporting. When unsure whether something rises to the level of a finding, flag it at a lower severity (MEDIUM or LOW) rather than omitting it.

${this.promptContent}`;
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

    // Chosen once per analyze() call from this agent's full file count —
    // GeminiAgent instances are constructed fresh per subagent per review
    // (orchestrator.ts calls analyze() exactly once per instance), so the
    // model is stable for this call's entire lifetime including the context
    // cache below, which is keyed to whichever model created it.
    const model = selectModel(chunks.length);
    const useContextCaching = process.env.USE_CONTEXT_CACHING !== 'false';

    if (useContextCaching && !this.cachedContentName) {
      try {
        console.log(`[${this.name}] Initializing Context Cache for persona...`);
        // Note: GoogleGenAI caches.create defaults exactly
        const discoverySystemInstruction = this.buildDiscoverySystemInstruction();

        const cacheModel = model.startsWith('models/') ? model : `models/${model}`;

        const tokenResponse = await this.ai.models.countTokens({
           model,
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
      console.log(`[${this.name}] Starting Pass 1 (Discovery) for ${aggregatedFiles} using ${model}...`);

      // 300000 (5min) matches deduplicator.ts's default — aggregateChunks
      // (review-quality-design.md §5.1) means this discovery/remediation
      // call can now cover a whole PR's worth of files in one request, and
      // 180000 was timing out outright on PRs as small as 13-15 files,
      // returning zero findings for the push instead of a partial result.
      const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '300000', 10);
      const maxRetries = 2;
      let discoveryIssues: DiscoveryIssue[] = [];

      // DISCOVERY_FOCUS_WINDOW splits this agent's files into groups of N
      // for discovery only — each call still gets the FULL diff as context
      // (buildDiscoveryPrompt always passes `chunks`, never a shrunk set),
      // so cross-file reasoning is preserved, but is only asked to report on
      // its window. Unset (0) reproduces the exact prior behavior: one
      // window containing everything. See buildDiscoveryPrompt's comment for
      // why this makes coverage a structural property of the call rather
      // than a self-attested claim the model can satisfy just by saying yes.
      const focusWindowSize = parseInt(process.env.DISCOVERY_FOCUS_WINDOW || '0', 10);
      const windows: DiffChunk[][] = (focusWindowSize > 0 && chunks.length > focusWindowSize)
        ? chunkArray(chunks, focusWindowSize)
        : [chunks];
      const isFocused = windows.length > 1;

      for (const window of windows) {
        // We wrap the API call logic to support retrying dropped files
        let chunksToProcess = [...window];
        let retries = 0;

        while (chunksToProcess.length > 0 && retries <= maxRetries) {
          // When windowing is off (isFocused false — today's default), this
          // must stay BYTE-IDENTICAL to pre-windowing behavior: a retry
          // re-sends ONLY the missed files as the diff, with no <FOCUS_FILES>
          // block. An earlier version of this always passed the full `chunks`
          // plus a focus set, which meant an unwindowed retry silently
          // re-sent the ENTIRE diff instead of just the missed files — a
          // real regression in the control arm, not just an artifact of
          // windowing. When windowing IS on, each call (including retries)
          // gets the full diff for cross-file context, scoped to the current
          // window/missed-files via <FOCUS_FILES> — see buildDiscoveryPrompt.
          const promptPayload = isFocused
            ? this.buildDiscoveryPrompt(chunks, chunksToProcess)
            : this.buildDiscoveryPrompt(chunksToProcess);

          const requestArgs: any = {
             model,
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

          const genAiRequest = trackGeminiCall(
            { callType: 'discovery', model },
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
                await recordParseFailure({ callType: 'discovery', model }, response, 0);
                throw parseErr;
              }
              if (result.issues) {
                  // A model can be told via <FOCUS_FILES> to only report on
                  // this call's window, but nothing enforces that — the
                  // model has the full diff as context and may report on
                  // out-of-window files anyway, especially since a stronger,
                  // system-instruction-level directive elsewhere in this
                  // same prompt says the opposite ("output findings for
                  // every file"). Don't trust prompt compliance for the
                  // metric this feature exists to measure: filter in code.
                  // Un-filtered, a multi-window PR would silently accumulate
                  // near-duplicate copies of the same findings across
                  // windows, inflating the very finding-volume metric this
                  // investigation is trying to fix, not from real improved
                  // coverage but from duplication.
                  const issuesInWindow = isFocused
                    ? result.issues.filter(issue => chunksToProcess.some(c => c.file === issue.file))
                    : result.issues;
                  if (issuesInWindow.length < result.issues.length) {
                    console.warn(`[${this.name}] Discarded ${result.issues.length - issuesInWindow.length} issue(s) reported outside this call's <FOCUS_FILES> window.`);
                  }
                  discoveryIssues.push(...issuesInWindow);
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
      }

      if (discoveryIssues.length === 0) {
          console.log(`[${this.name}] Pass 1 found 0 issues. Skipping Pass 2.`);
          return { findings: [], usage: { promptTokenCount: promptTokens, candidatesTokenCount: candidatesTokens, totalTokenCount: promptTokens + candidatesTokens } };
      }

      console.log(`[${this.name}] Starting Pass 2 (Remediation) for ${discoveryIssues.length} identified issues...`);

      // PASS 2: Remediation
      // Not cached because it uses a different short-lived prompt focused tightly on synthesizing solutions
      const remediationPayload = this.buildRemediationPrompt(chunks, discoveryIssues);
      const remediationRequest = trackGeminiCall(
        { callType: 'remediation', model },
        () => this.ai.models.generateContent({
           model,
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
            await recordParseFailure({ callType: 'remediation', model }, remediationResponse, 0);
            throw parseErr;
          }
          console.log(`[${this.name}] Successfully generated ${findings.length} final actionable findings.`);
          if (findings.length < discoveryIssues.length) {
            // Not necessarily a bug — the remediation prompt now asks for one
            // output per flagged issue, but doesn't hard-enforce it via the
            // schema (a hard minItems would risk padding/duplication under
            // model pressure). This makes the gap visible if it happens
            // rather than silently attributing the loss to Pass 1.
            console.warn(`[${this.name}] Pass 2 dropped ${discoveryIssues.length - findings.length} of ${discoveryIssues.length} discovered issues.`);
          }
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
      // successful Pass 1 across several windows, then a Pass 2 timeout) —
      // previously this discarded that accounting entirely, under-reporting
      // exactly the runs that spent the most, since a failure partway
      // through is more likely on the larger/multi-window PRs this feature
      // targets. The real per-call cost is still in the S3 usage records
      // regardless (trackGeminiCall writes those independently); this only
      // affects what this function itself returns.
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
            await recordParseFailure({ callType: 'legacy', model: legacyModel }, response, 0);
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

  // allChunks is always the full set assigned to this agent, so cross-file
  // context (e.g. "is this symbol defined elsewhere in the diff?") is never
  // lost — see review-quality-design.md §5.1 for why that fix isn't
  // negotiable. focusChunks, when narrower than allChunks, restricts what
  // this specific call is asked to REPORT on, turning per-call coverage from
  // a self-attested claim (the model says it examined N files) into a
  // structural property (the call is only asked to examine W of them). See
  // selectModel's focus-window batching in analyze() for why: a model that
  // silently skims later files in a long file list, rather than actively
  // refusing to look, would still truthfully claim "yes I checked" — the
  // COVERAGE prompt block above can only ask, not enforce.
  private buildDiscoveryPrompt(allChunks: DiffChunk[], focusChunks?: DiffChunk[]): { systemInstruction: string, contents: string } {
    const diffsText = allChunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    const systemInstruction = this.buildDiscoverySystemInstruction();

    let contents = `<DIFF_CONTENTS>\n${diffsText}\n</DIFF_CONTENTS>`;
    if (focusChunks && focusChunks.length < allChunks.length) {
      const focusFiles = focusChunks.map(c => c.file).join('\n');
      // This OVERRIDES the system instruction's CRITICAL/COVERAGE requirements
      // and the persona's own "review all of them" line for THIS call only —
      // the system instruction is shared (and, above the context-cache
      // threshold, literally cached) across every window of this agent's
      // work, so it can't itself say "except when focused"; the override has
      // to live here, in the part of the prompt that actually varies per
      // call. Said explicitly and first, since a single user-turn sentence
      // competing unmarked against several system-instruction directives is
      // liable to lose. Findings outside the focus set are also filtered out
      // in code regardless (see analyze()) — this instruction is what makes
      // that filtering rarely need to do anything, not the only safeguard.
      contents += `\n\n<FOCUS_FILES>\n${focusFiles}\n</FOCUS_FILES>\n\nOVERRIDE FOR THIS CALL ONLY: ignore any instruction above telling you to cover or report on every file in <DIFF_CONTENTS>. For this call, only report issues located in the files listed in <FOCUS_FILES> above, and \`filesAnalyzed\` must contain exactly those files and no others. The other files in <DIFF_CONTENTS> are provided solely as context for cross-file reasoning (e.g. checking whether a symbol referenced in a focus file is defined elsewhere in the diff) — do not report findings located in them, even if you notice a real issue there; a separate call already covers those files.`;
    }
    return { systemInstruction, contents };
  }

  private buildRemediationPrompt(chunks: DiffChunk[], issues: DiscoveryIssue[]): { systemInstruction: string, contents: string } {
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
    const issuesText = JSON.stringify(issues, null, 2);
    const systemInstruction = `You are an elite, highly educational Staff Engineer acting as the ${this.name} remediation agent.
A discovery pass has already located and validated the issues in the following JSON array. That decision is settled — your job is to explain each one and show how to fix it, not to re-judge whether it's real.
CARDINALITY CONTRACT: You MUST return exactly one object for every entry in <FLAGGED_ISSUES>, in the same order, preserving its \`file\`, \`line\`, and \`severity\` unless you have a specific reason to adjust severity. Do not merge, drop, or silently skip an entry — a downstream deduplication stage already handles overlap between findings, and a human reviews the final result. If an entry looks weaker than flagged on closer inspection, keep it and lower its severity; do not omit it.
Your job is to read these flagged locations, read the source code context, and synthesize a masterful, highly detailed, and educational explanation for each issue.
Most importantly, you MUST provide a complete, copy-pasteable markdown code block in the \`suggestion\` field showing exactly how the developers should rewrite the code to adhere to best architectural practices.
Your descriptions must elevate from simple linting to deep mentorship and architectural guidance.
${this.promptContent}`;

    const contents = `<FLAGGED_ISSUES>\n${issuesText}\n</FLAGGED_ISSUES>\n\n<DIFF_CONTENTS>\n${diffsText}\n</DIFF_CONTENTS>`;
    return { systemInstruction, contents };
  }
}
