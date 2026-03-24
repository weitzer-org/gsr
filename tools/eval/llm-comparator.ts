import { GoogleGenAI } from '@google/genai';
import { ReviewFinding } from './api-client';

const MODEL_NAME = 'gemini-2.5-pro';

/**
 * Compare the results from two different environments using Gemini
 * @param prUrl The context PR
 * @param targetALabel The semantic label for the first source (e.g. "Local" or "Branch 'feat-x'")
 * @param targetBLabel The semantic label for the second source (e.g. "Production")
 */
export async function compareResultsWithLLM(
  prUrl: string, 
  targetAFindings: ReviewFinding[], 
  targetBFindings: ReviewFinding[],
  targetALabel: string,
  targetBLabel: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY must be set in the environment to run the evaluator.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You are an expert software engineering evaluator. Your job is to compare the output of an AI code review tool across two different versions of the tool ("${targetALabel}" vs "${targetBLabel}").

Context PR: ${prUrl}

Below you are given the JSON output of findings from both environments. 

${targetBLabel} Findings:
\`\`\`json
${JSON.stringify(targetBFindings, null, 2)}
\`\`\`

${targetALabel} Findings:
\`\`\`json
${JSON.stringify(targetAFindings, null, 2)}
\`\`\`

Analyze the two sets of findings and provide a comprehensive comparison report covering the following criteria:
4. **Accuracy**: Did the ${targetALabel} version find more accurate or relevant bugs than ${targetBLabel}?
5. **Finding Counts & Regressions**: Compare the total number of findings caught. Fewer findings is inherently BETTER if the findings are consolidated or less noisy. Do not penalize lower finding counts unless severe, critical bugs were entirely missed.
6. **Source Analysis**: Note if any errors/improvements in the ${targetALabel} version are driven more by 'subagent' findings or 'basic' findings (each finding has a 'source' tag).
7. **Duplication & Noise**: Does one version present concise, highly actionable summaries while the other produces rambling, duplicated noise? Explicitly reward the version that deduplicates overlapping findings and is more concise. If ${targetALabel} correctly consolidated these duplicates into a single actionable finding, unequivocally praise it as an Improvement. If ${targetBLabel} is merely repeating itself, it should NEVER be credited for finding "more" bugs.
5. **Formatting & Readability**: Which version resulted in better, clearer markdown and structure?
6. **Actionability**: Are the suggestions provided by the ${targetALabel} version more actionable?
7. **False Positives**: Does the ${targetALabel} version introduce new noisy false positives compared to ${targetBLabel}?

Provide your report in clean Markdown. Conclude with a clear verdict on whether the ${targetALabel} version is an "Improvement", "Regression", or "Neutral" change compared to ${targetBLabel}.
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
 * @param aggregateMetrics Object containing aggregated metrics for both targets.
 */
export async function generateAggregateReport(individualReports: string[], aggregateMetrics: any, targetALabel: string, targetBLabel: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY must be set in the environment to run the evaluator.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You are an expert software engineering manager evaluating a suite of recent experiments on an AI code review tool.
Your team recently ran an evaluation harness testing a "${targetALabel}" version of the tool against the baseline "${targetBLabel}" version across several Pull Requests. 

The evaluation suite generated individual summary reports for each Pull Request, which are provided below:

<INDIVIDUAL_REPORTS>
${individualReports.map((report, idx) => `### PR Report ${idx + 1}\n${report}`).join('\n\n================================\n\n')}
</INDIVIDUAL_REPORTS>

Additionally, here are the aggregate metrics collected across all Pull Request reviews:

<AGGREGATE_METRICS>
${JSON.stringify(aggregateMetrics, null, 2)}
</AGGREGATE_METRICS>

Your task is to synthesize these individual PR reports and aggregate metrics into a single, cohesive Executive Summary. 
Highlight the common strengths, consistent weaknesses (e.g., if there's a recurring bug like hallucinated line numbers), overall trends, and discuss the aggregate token/call usage differences between the ${targetALabel} and ${targetBLabel} versions. Note if one version provided a cleaner, deduplicated output compared to the other.
CRITICAL: The Individual Reports now contain TWO unique comparisons per PR:
1. **${targetALabel} vs ${targetBLabel} Comparison**: How the new branch compares to production.
2. **Subagent vs Basic Agent Comparison**: How the Subagent swarm fared against the Basic agent baseline on the same branch.
You MUST dedicate a specific section of your Executive Summary to explicitly analyze the "Subagent vs Basic" performance, praising the agent that yields fewer but higher-quality, non-duplicate findings. Treat lower finding counts as a significant architectural success if Subagents efficiently deduplicated the noise of the baseline agent.
Include explicit Quantitative Finding Counts: "${targetALabel} identified X total findings across the PRs compared to ${targetBLabel}'s Y findings". 
Conclude with a final overall verdict (Improvement/Regression/Neutral) for the branch comparison and include Actionable Next Steps.

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
