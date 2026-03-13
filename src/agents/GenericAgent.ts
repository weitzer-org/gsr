import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';

export class GenericAgent implements Subagent {
  name: string;
  private tomlFileName: string;
  private ai = new GoogleGenAI(); 

  constructor(name: string, tomlFileName: string) {
    this.name = name;
    this.tomlFileName = tomlFileName;
  }

  async analyze(chunk: DiffChunk): Promise<CandidateFinding[]> {
    const prompt = this.buildPrompt(chunk);
    
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-pro',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           responseSchema: {
             type: Type.ARRAY,
             description: `A list of issues found in the code diff based on the ${this.name} agent protocols.`,
             items: {
               type: Type.OBJECT,
               properties: {
                 file: { type: Type.STRING },
                 line: { type: Type.INTEGER },
                 severity: { type: Type.STRING, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
                 summary: { type: Type.STRING },
                 description: { type: Type.STRING },
                 suggestion: { type: Type.STRING, nullable: true }
               },
               required: ["file", "line", "severity", "summary", "description"]
             }
           }
         }
      });

      if (response.text) {
          const findings = JSON.parse(response.text) as CandidateFinding[];
          return findings.map(f => ({ ...f, file: chunk.file }));
      }
      return [];

    } catch (e) {
      console.error(`⚠️ Note: The ${this.name} Agent failed to complete its review for ${chunk.file}`, e);
      return [];
    }
  }

  private buildPrompt(chunk: DiffChunk): string {
    const promptPath = path.join(process.cwd(), 'prompts', this.tomlFileName);
    const tomlContent = fs.readFileSync(promptPath, 'utf8');
    const parsed = toml.parse(tomlContent);
    let promptTemplate = parsed.prompt || "";
    
    return promptTemplate
      .replace('{{FILE_PATH}}', chunk.file)
      .replace('{{DIFF_CONTENT}}', chunk.content);
  }
}
