import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';

export class LogicAgent implements Subagent {
  name = 'Logic';
  // Note: users must have GEMINI_API_KEY set in their environment
  private ai = new GoogleGenAI({}); 

  async analyze(chunk: DiffChunk): Promise<CandidateFinding[]> {
    const prompt = this.buildPrompt(chunk);
    
    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-pro',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           // Force the LLM to output exactly our CandidateFinding array schema
           responseSchema: {
             type: Type.ARRAY,
             description: "A list of potential bugs, logic errors, performance bottlenecks, and clarity issues found in the code diff.",
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
                   description: "A single sentence summary of the issue"
                 },
                 description: {
                   type: Type.STRING,
                   description: "More details about the issue, including why it is an issue"
                 },
                 suggestion: {
                   type: Type.STRING,
                   nullable: true,
                   description: "An optional code snippet demonstrating how to fix the issue. Only include the modified code."
                 }
               },
               required: ["file", "line", "severity", "summary", "description"]
             }
           }
         }
      });

      if (response.text) {
          const findings = JSON.parse(response.text) as CandidateFinding[];
          // Ensure file paths are consistent with the chunk we fed it
          return findings.map(f => ({ ...f, file: chunk.file }));
      }
      return [];

    } catch (e) {
      console.error(`⚠️ Note: The Logic Agent failed to complete its review for ${chunk.file}`, e);
      return [];
    }
  }

  private buildPrompt(chunk: DiffChunk): string {
    const promptPath = path.join(process.cwd(), 'prompts', 'logic.toml');
    const tomlContent = fs.readFileSync(promptPath, 'utf8');
    const parsed = toml.parse(tomlContent);
    let promptTemplate = parsed.prompt || "";
    
    return promptTemplate
      .replace('{{FILE_PATH}}', chunk.file)
      .replace('{{DIFF_CONTENT}}', chunk.content);
  }
}
