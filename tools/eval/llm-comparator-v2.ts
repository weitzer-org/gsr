import { GoogleGenAI } from '@google/genai';
import { ReviewFinding } from './api-client';

const MODEL_NAME = 'gemini-2.5-pro';

export interface TargetMetrics {
  actionability: number;
  falsePositives: number;
  uniqueFindings: number;
}

export interface V2ComparisonMetrics {
  targetA: TargetMetrics;
  targetB: TargetMetrics;
  gca: TargetMetrics;
  codeRabbit: TargetMetrics;
  overlapMatrix: {
    targetA_targetB: number;
    targetA_gca: number;
    targetA_codeRabbit: number;
    targetB_gca: number;
    targetB_codeRabbit: number;
    gca_codeRabbit: number;
  };
}

export interface V2ComparisonResult {
  report: string;
  metrics: V2ComparisonMetrics;
}

export async function compareResultsWithLLMV2(
  prUrl: string, 
  targetAFindings: ReviewFinding[], 
  targetBFindings: ReviewFinding[],
  gcaFindings: ReviewFinding[],
  codeRabbitFindings: ReviewFinding[],
  targetALabel: string,
  targetBLabel: string
): Promise<V2ComparisonResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY must be set in the environment to run the evaluator.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
You are an expert software engineering evaluator. Your job is to compare the output of FOUR different AI code review tools ("${targetALabel}", "${targetBLabel}", "Gemini Code Assist", and "CodeRabbit") on a single pull request.

Context PR: ${prUrl}

Below you are given the JSON output of valid findings from all environments. 

${targetALabel} Findings:
\`\`\`json
${JSON.stringify(targetAFindings, null, 2)}
\`\`\`

${targetBLabel} Findings:
\`\`\`json
${JSON.stringify(targetBFindings, null, 2)}
\`\`\`

Gemini Code Assist Findings:
\`\`\`json
${JSON.stringify(gcaFindings, null, 2)}
\`\`\`

CodeRabbit Findings:
\`\`\`json
${JSON.stringify(codeRabbitFindings, null, 2)}
\`\`\`

Analyze the sets of findings and provide a comprehensive comparison report covering the following criteria:
1. **Actionability Score (1-10):** Assess the concrete usefulness of suggestions. Does the agent provide highly actionable code or just conceptually complain?
2. **False Positive Estimate:** Count findings that are objectively invalid or hallucinated (even if they fell within the allowed diff lines, are they completely irrelevant logic?).
3. **Unique Findings:** Correlate finding locations and semantics to count uniquely identified bugs for each target.

Provide your qualitative report in clean Markdown.

CRITICAL JSON INSTRUCTION:
You MUST append a strict JSON block exactly matching this schema at the very end of your response, capturing the numerical scores for your analysis:
\`\`\`json
{
  "targetA": { "actionability": 8, "falsePositives": 0, "uniqueFindings": 3 },
  "targetB": { "actionability": 5, "falsePositives": 2, "uniqueFindings": 1 },
  "gca": { "actionability": 6, "falsePositives": 1, "uniqueFindings": 0 },
  "codeRabbit": { "actionability": 7, "falsePositives": 0, "uniqueFindings": 2 },
  "overlapMatrix": {
    "targetA_targetB": 2,
    "targetA_gca": 1,
    "targetA_codeRabbit": 0,
    "targetB_gca": 1,
    "targetB_codeRabbit": 0,
    "gca_codeRabbit": 0
  }
}
\`\`\`
Replace the numbers with your actual evaluation. Do not write anything after the JSON block.
`;

  try {
    console.log(`Asking Gemini to evaluate the V2 comparison...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: { temperature: 0.2 }
    });

    if (!response.text) throw new Error('LLM returned empty text');

    let metrics: V2ComparisonMetrics;
    const emptyTarget = { actionability: 0, falsePositives: 0, uniqueFindings: 0 };
    const emptyMetrics = { targetA: { ...emptyTarget }, targetB: { ...emptyTarget }, gca: { ...emptyTarget }, codeRabbit: { ...emptyTarget }, overlapMatrix: { targetA_targetB: 0, targetA_gca: 0, targetA_codeRabbit: 0, targetB_gca: 0, targetB_codeRabbit: 0, gca_codeRabbit: 0 } };
    
    try {
      const jsonMatch = response.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        metrics = JSON.parse(jsonMatch[1]);
      } else {
        metrics = emptyMetrics;
      }
    } catch(e) {
      metrics = emptyMetrics;
    }

    console.log(`✅ V2 Evaluation complete.`);
    return { report: response.text, metrics };
  } catch (err) {
    console.error('Failed to run LLM Comparison.', err);
    throw err;
  }
}

export async function generateAggregateReportV2(
  individualReports: string[], 
  aggregateMetrics: any, 
  targetALabel: string, 
  targetBLabel: string,
  llmAggregatedMetrics: any
): Promise<string> {
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

Additionally, here are the calculated metrics collected across all Pull Request reviews:

<AGGREGATE_METRICS>
${JSON.stringify(aggregateMetrics, null, 2)}
</AGGREGATE_METRICS>

<LLM_COMPARISON_METRICS>
${JSON.stringify(llmAggregatedMetrics, null, 2)}
</LLM_COMPARISON_METRICS>

Your task is to synthesize these individual PR reports and metrics into a single, cohesive Executive Summary. 
Highlight common strengths, consistent weaknesses, and compare performance between ${targetALabel} and ${targetBLabel}. 

CRITICAL: You MUST include an explicit, easy-to-read "Metrics Comparison Matrix" (Markdown Table) at the very top of your executive summary before diving into the qualitative discussion. 
The table MUST include 5 columns: Metric, ${targetALabel}, ${targetBLabel}, Gemini Code Assist, and CodeRabbit.
It should summarize Total Findings, Average Actionability, Total False Positives, and Unique Findings using the provided <AGGREGATE_METRICS> and <LLM_COMPARISON_METRICS>. Note: "Total False Positives" includes both diff-validation hallucinations and logic hallucinations identified by the evaluator.

You must also include an explicit 4x4 "Overlap Matrix" below the main metrics. The Overlap Matrix MUST mathematically display the pairwise overlap intersections sourced directly from the "overlapMatrix" section of the <LLM_COMPARISON_METRICS>. The columns and rows of this matrix should be the 4 targets (${targetALabel}, ${targetBLabel}, Gemini Code Assist, CodeRabbit). The intersection values represent how many bugs both targets successfully flagged.

Format your output in clean Markdown.
`;

  try {
    console.log(`Asking Gemini to generate an aggregate V2 evaluation summary...`);
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: { temperature: 0.2 }
    });

    if (!response.text) throw new Error('LLM returned empty text for aggregate report');
    console.log(`✅ Aggregate V2 evaluation complete.`);
    return response.text;
  } catch (err) {
    console.error('Failed to run aggregate LLM Comparison.', err);
    throw err;
  }
}
