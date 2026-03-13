import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding, DiffChunk, Subagent } from './types';
import * as fs from 'fs';
import * as path from 'path';

export class GeminiAgent implements Subagent {
  name: string;
  private markdownFileName: string;
  private ai: GoogleGenAI;

  constructor(name: string, markdownFileName: string) {
    this.name = name;
    this.markdownFileName = markdownFileName;
    // The SDK automatically picks up GOOGLE_APPLICATION_CREDENTIALS for ADC,
    // or GEMINI_API_KEY from the environment.
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); 
  }

  async analyze(chunk: DiffChunk): Promise<CandidateFinding[]> {
    const prompt = this.buildPrompt(chunk);
    
    try {
      console.log(`[${this.name}] Starting Gemini API call for ${chunk.file}...`);
      
      const response = await this.ai.models.generateContent({
         model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
         contents: prompt,
         config: {
           responseMimeType: 'application/json',
           responseSchema: {
             type: Type.ARRAY,
             description: "A list of potential findings or issues found in the code diff based on the system instructions.",
             items: {
               // ... maintaining schema ...
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
      
      console.log(`[${this.name}] Received Gemini API response for ${chunk.file}`);

      if (response.text) {
          const findings = JSON.parse(response.text) as CandidateFinding[];
          return findings.map(f => ({ ...f, file: chunk.file, agent: this.name }));
      }
      return [];

    } catch (e) {
      console.error(`⚠️ Note: The ${this.name} Agent failed to complete its review for ${chunk.file}`, e);
      return [];
    }
  }

  private buildPrompt(chunk: DiffChunk): string {
    // Assuming backend is run from /adk/backend or /adk/backend/dist
    const projectRoot = typeof __dirname !== 'undefined' 
        ? path.resolve(__dirname, '../../../')
        : path.resolve(process.cwd(), '../../');
    const promptPath = path.join(projectRoot, 'gemini-cli-extension', 'system_prompts', this.markdownFileName);
    
    let instructions = "";
    try {
      instructions = fs.readFileSync(promptPath, 'utf8');
    } catch (e) {
      console.error(`Could not read prompt file for ${this.name}: ${promptPath}`);
      instructions = `You are the ${this.name} agent. Review the following code diff.`;
    }
    
    return `
<SYSTEM_INSTRUCTIONS>
${instructions}
</SYSTEM_INSTRUCTIONS>

<FILE_PATH>
${chunk.file}
</FILE_PATH>

<DIFF_CONTENT>
${chunk.content}
</DIFF_CONTENT>
`;
  }
}
