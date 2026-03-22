import { GoogleGenAI, Type } from '@google/genai';
import { DiffChunk } from './types';
import * as fs from 'fs';
import * as path from 'path';

export class TriageRouter {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async predictRouting(
    chunks: DiffChunk[],
    availableAgents: { name: string; promptContent: string }[]
  ): Promise<{ routingMap: Record<string, string[]>, usage: { promptTokens: number, candidatesTokens: number } }> {
    const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '60000', 10);
    let promptTokens = 0;
    let candidatesTokens = 0;

    // Use full agent contexts for maximum routing accuracy per User requirement.
    const agentsDescriptions = availableAgents
      .map(a => `Agent: ${a.name}\nScope/Prompt:\n${a.promptContent}`)
      .join('\n\n--------------------\n\n');
      
    // Use full diffs per User requirement.
    const diffsText = chunks.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');

    const currentDir = typeof __dirname !== 'undefined' ? __dirname : undefined;
    let fallbackSystemInstruction = `You are a highly efficient Triage Router for a Code Review system.
You will be provided with:
1. A list of available specialized subagents and their capabilities (prompts).
2. The code diffs for a Pull Request.

Your job is to read the code diffs and determine WHICH subagents should review WHICH files.
Return a JSON object where each key is a filename from the pull request, and the value is an array of agent names that should review it.
If a file does not need review by any agent, map it to an empty array.
Be precise to save downstream tokens: only assign an agent if their scope directly matches the changes in that file.`;
    
    let systemInstruction = fallbackSystemInstruction;
    try {
        let projectRoot = '';
        if (currentDir) {
            const isCompiled = currentDir.includes(path.join('dist', 'src'));
            projectRoot = isCompiled 
                ? path.resolve(currentDir, '../../../../') 
                : path.resolve(currentDir, '../../../');
        } else {
            projectRoot = path.resolve(process.cwd(), '../../');
        }
        
        const tomlPath = path.join(projectRoot, 'gemini-cli-extension', 'prompts', 'triage.toml');
        if (fs.existsSync(tomlPath)) {
            const content = fs.readFileSync(tomlPath, 'utf8');
            const match = content.match(/prompt\s*=\s*"""([\s\S]*?)"""/);
            if (match && match[1]) {
                systemInstruction = match[1].trim();
                console.log('[TriageRouter] Loaded external prompt from triage.toml');
            }
        }
    } catch (e) {
        console.warn('[TriageRouter] Failed to load external triage prompt, using fallback.', e);
    }

    const contents = `Available Agents:\n${agentsDescriptions}\n\nPull Request Diffs:\n${diffsText}`;

    try {
      console.log(`[TriageRouter] Starting routing prediction for ${chunks.length} files...`);
      const request = this.ai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        contents,
        config: {
          systemInstruction,
          responseMimeType: 'application/json'
        }
      });

      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<any>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Triage Router fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
      });

      const response = await Promise.race([request, timeoutPromise]).finally(() => clearTimeout(timeoutId));

      if (response.usageMetadata) {
          promptTokens += response.usageMetadata.promptTokenCount || 0;
          candidatesTokens += response.usageMetadata.candidatesTokenCount || 0;
      }

      if (response.text) {
          const routingMap = JSON.parse(response.text) as Record<string, string[]>;
          console.log(`[TriageRouter] Successfully generated routing map. Tokens: ${promptTokens + candidatesTokens}`);
          return { routingMap: routingMap || {}, usage: { promptTokens, candidatesTokens } };
      }
      
      console.warn(`[TriageRouter] Empty response. Returning empty routing map.`);
      return { routingMap: {}, usage: { promptTokens, candidatesTokens } };

    } catch (e) {
      console.error(`[TriageRouter] Failed to predict routing:`, e);
      throw e;
    }
  }
}
