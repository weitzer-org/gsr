import { GoogleGenAI } from '@google/genai';
import { CandidateFinding } from './types';

export class Evaluator {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async evaluateComparison(subagentFindings: CandidateFinding[], basicFindings: CandidateFinding[]): Promise<string> {
    const prompt = `
You are a Staff Software Engineer analyzing the results of an AI-powered code review comparison.
Two different AI review approaches were tested on the same GitHub Pull Request:
1. Subagent Approach: A swarm of specialized agents (Security, Logic, Dependencies, etc.) reviewed the code.
2. Basic Approach: A single large prompt containing generic "Principal Engineer" rules reviewed the code.

Given the results below, write a brief, narrative description comparing the two approaches.
Address the following:
- Which approach found more critical/high severity issues?
- What kinds of issues did the subagents focus on versus the basic approach?
- Were there false positives or differences in quality?
- Which method appeared generally more effective for this pull request?

<SUBAGENT_FINDINGS>
${JSON.stringify(subagentFindings, null, 2)}
</SUBAGENT_FINDINGS>

<BASIC_FINDINGS>
${JSON.stringify(basicFindings, null, 2)}
</BASIC_FINDINGS>

Format your output in professional Markdown. Keep it under 250 words and be highly analytical.
`;

    try {
      console.log(`[Evaluator] Starting Gemini API call for comparison evaluation...`);
      
      const response = await this.ai.models.generateContent({
         model: process.env.GEMINI_MODEL || 'gemini-2.5-pro',
         contents: prompt,
      });
      
      console.log(`[Evaluator] Received Gemini API response for comparison evaluation`);
      return response.text || "No evaluation generated.";
    } catch (e) {
      console.error(`⚠️ Note: The Evaluator failed to complete its comparison`, e);
      return "Comparison evaluation failed due to an error.";
    }
  }
}
