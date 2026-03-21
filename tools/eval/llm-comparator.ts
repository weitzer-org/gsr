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
2. **Finding Counts & Regressions**: Compare the total number of findings caught. Did the Local version completely miss important bugs that Production successfully caught?
3. **Source Analysis**: Note if any errors/improvements in the Local version are driven more by 'subagent' findings or 'basic' findings (each finding has a 'source' tag).
4. **Formatting & Readability**: Which version resulted in better, clearer markdown and structure?
5. **Actionability**: Are the suggestions provided by the Local version more actionable?
6. **False Positives**: Does the Local version introduce new noisy false positives compared to Production?

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

/**
 * Generate an aggregate summary of multiple individual PR evaluation reports.
 * @param individualReports Array of markdown strings from the individual compareResultsWithLLM calls.
 * @param aggregateMetrics Object containing aggregated metrics for local and production.
 */
export async function generateAggregateReport(individualReports: string[], aggregateMetrics: any): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY must be set in the environment to run the evaluator.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You are an expert software engineering manager evaluating a suite of recent experiments on an AI code review tool.
Your team recently ran an evaluation harness testing a new "Local" version of the tool against the baseline "Production" version across several Pull Requests. 

The evaluation suite generated individual summary reports for each Pull Request, which are provided below:

<INDIVIDUAL_REPORTS>
${individualReports.map((report, idx) => `### PR Report ${idx + 1}\n${report}`).join('\n\n================================\n\n')}
</INDIVIDUAL_REPORTS>

Additionally, here are the aggregate metrics collected across all Pull Request reviews:

<AGGREGATE_METRICS>
${JSON.stringify(aggregateMetrics, null, 2)}
</AGGREGATE_METRICS>

Your task is to synthesize these individual PR reports and aggregate metrics into a single, cohesive Executive Summary. 
Highlight the common strengths, consistent weaknesses (e.g., if there's a recurring bug like hallucinated line numbers), overall trends, and discuss the aggregate token/call usage differences between the Local and Production versions.
Include explicit Quantitative Finding Counts: "Local identified X total findings across the 10 PRs compared to Production's Y findings" (use findingsCount from the metrics).
Conclude with a final overall verdict (Improvement/Regression/Neutral) and include Actionable Next Steps (e.g. prompt tweaks or architecture changes to fix identified regressions).

Format your output in clean Markdown.
`;

  try {
    console.log(`Asking Gemini to generate an aggregate evaluation summary...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        temperature: 0.2, // Keep it grounded
      }
    });

    if (!response.text) {
      throw new Error('LLM returned empty text for aggregate report');
    }

    console.log(`✅ Aggregate evaluation complete.`);
    return response.text;
  } catch (err) {
    console.error('Failed to run aggregate LLM Comparison.', err);
    throw err;
  }
}
