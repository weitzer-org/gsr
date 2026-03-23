import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';

export class SecurityAgent implements Subagent {
  name = 'Security';
  private ai = new GoogleGenAI({}); 

  async analyze(chunk: DiffChunk): Promise<CandidateFinding[]> {
    const prompt = this.buildPrompt(chunk);
    
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           responseSchema: {
             type: Type.ARRAY,
             description: "A list of security vulnerabilities found in the code diff.",
             items: {
               type: Type.OBJECT,
               properties: {
                 file: {
                   type: Type.STRING,
                   description: "The path of the file being reviewed"
                 },
                 line: {
                   type: Type.INTEGER,
                   description: "The starting line number of the issue in the diff"
                 },
                 severity: {
                   type: Type.STRING,
                   enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
                   description: "The severity of the issue"
                 },
                 summary: {
                   type: Type.STRING,
                   description: "A single sentence summary of the vulnerability"
                 },
                 description: {
                   type: Type.STRING,
                   description: "Detailed explanation of the vulnerability and attack vector"
                 },
                 suggestion: {
                   type: Type.STRING,
                   nullable: true,
                   description: "Code snippet demonstrating how to fix the vulnerability."
                 }
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
      console.error(`⚠️ Note: The Security Agent failed to complete its review for ${chunk.file}`, e);
      return [];
    }
  }

  private buildPrompt(chunk: DiffChunk): string {
    const promptPath = path.join(process.cwd(), 'prompts', 'security.toml');
    const tomlContent = fs.readFileSync(promptPath, 'utf8');
    const parsed = toml.parse(tomlContent);
    let promptTemplate = parsed.prompt || "";
    
    return promptTemplate
      .replace('{{FILE_PATH}}', chunk.file)
      .replace('{{DIFF_CONTENT}}', chunk.content);
  }
}
