import { GoogleGenAI } from '@google/genai';
import { ReviewFinding } from './api-client';

const MODEL_NAME = 'gemini-2.5-pro';

/**
 * Compare the results from two different environments using Gemini
 * @param prUrl The context PR
 * @param localFindings Findings from the local build
 * @param prodFindings Findings from the production build
 */
export async function compareResultsWithLLM(
  prUrl: string, 
  localFindings: ReviewFinding[], 
  prodFindings: ReviewFinding[]
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY must be set in the environment to run the evaluator.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You are an expert software engineering evaluator. Your job is to compare the output of an AI code review tool across two different versions of the tool ("Local" vs "Production").

Context PR: ${prUrl}

Below you are given the JSON output of findings from both environments. 

Production Findings:
\`\`\`json
${JSON.stringify(prodFindings, null, 2)}
\`\`\`

Local Findings (The new proposed changes to the review tool):
\`\`\`json
${JSON.stringify(localFindings, null, 2)}
\`\`\`

Analyze the two sets of findings and provide a comprehensive comparison report covering the following criteria:
1. **Accuracy**: Did the Local version find more accurate or relevant bugs than Production?
2. **Regressions**: Did the Local version completely miss important bugs that Production successfully caught?
3. **Formatting & Readability**: Which version resulted in better, clearer markdown and structure?
4. **Actionability**: Are the suggestions provided by the Local version more actionable?
5. **False Positives**: Does the Local version introduce new noisy false positives compared to Production?

Provide your report in clean Markdown. Conclude with a clear verdict on whether the Local version is an "Improvement", "Regression", or "Neutral" change.
`;

  try {
    console.log(`Asking Gemini to evaluate the comparison...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        temperature: 0.2, // Keep it grounded
      }
    });

    if (!response.text) {
      throw new Error('LLM returned empty text');
    }

    console.log(`✅ Evaluation complete.`);
    return response.text;
  } catch (err) {
    console.error('Failed to run LLM Comparison.', err);
    throw err;
  }
}
