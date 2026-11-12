import { GoogleGenAI } from '@google/genai';
import { ReviewFinding } from './api-client';
import { trackGeminiCall } from './usage';

// The judge. JUDGE_MODEL overrides it (and callers can pass `opts.model` per call, which is how the
// harness runs a second, different judge over the same pair). The default is unchanged.
export const DEFAULT_JUDGE_MODEL = 'gemini-2.5-pro';
const MODEL_NAME = DEFAULT_JUDGE_MODEL;

export function resolveJudgeModel(explicit?: string, env: Record<string, string | undefined> = process.env): string {
  return explicit || env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
}

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
  // false when the judge's own numbers are internally impossible (uniqueFindings
  // exceeding how many findings that target actually had) — a confirmed failure
  // mode distinct from the key-naming mismatch normalizeV2Metrics handles: the
  // JSON block can use the correct literal "targetA"/"targetB" keys yet still
  // transcribe one target's score under the other's key. Seen concretely: a
  // judge run praised "Production" at length in prose (9 unique findings, a
  // "senior staff engineer" review) while "Local" had made a single trivial
  // finding — but the trailing JSON scored targetA (Local) 10/10 with 9 unique
  // findings and targetB (Production) 8/10 with 0. Downstream consumers should
  // treat metrics as unreliable for a PR where this is false.
  plausible: boolean;
  // Why `plausible` is false, when it is (for the harness's integrity table).
  implausibleReason?: string;
  // The judge that was asked, and the model that actually answered
  // (response.modelVersion). Compare them: a judge verdict from a model that
  // wasn't the requested judge is not a verdict from that judge.
  judgeModel?: string;
  judgeServedModel?: string;
}

// The judge is asked to always key its JSON block "targetA"/"targetB", but the prompt also
// tells it to call the tools by their labels throughout the prose report — it sometimes carries
// that labeling into the JSON keys too, despite the explicit instruction not to. A silently-dropped
// or zeroed row from this mismatch corrupts every downstream aggregate.
//
// A key is resolved ONLY by (1) the literal canonical name, or (2) the label of the target being
// resolved, case-insensitively, as passed in by the caller. The labels passed in are the labels
// the judge was actually shown, so they already follow the per-PR judge-order swap (evaluate.ts
// passes the swapped pair). An earlier version also tried the hard-coded keys 'local' /
// 'production' as a fallback, which ignored the swap: with labels ('Production', 'Local') both
// targets matched the same first key and the result had targetA === targetB — a fabricated tie.
//
// Anything ambiguous is reported implausible rather than guessed at:
//   - the two labels are equal (case-insensitively), so a key cannot identify a target;
//   - a label matches more than one key, or a key could belong to both targets;
//   - a target has no key at all (its zeros would be the fallback's, not the judge's);
//   - both targets resolve to the same object.
export interface ResolvedV2Metrics {
  metrics: V2ComparisonMetrics;
  plausible: boolean;
  reason?: string;
}

export function resolveV2Metrics(
  raw: any,
  targetALabel: string,
  targetBLabel: string,
  fallback: V2ComparisonMetrics
): ResolvedV2Metrics {
  if (!raw || typeof raw !== 'object') {
    return { metrics: fallback, plausible: false, reason: 'judge returned no parseable JSON block' };
  }

  const lower = (x: string) => x.toLowerCase();
  const ambiguousLabels = lower(targetALabel) === lower(targetBLabel);

  type Found = { value?: TargetMetrics; ambiguous: boolean };
  const find = (canonical: 'targetA' | 'targetB', label: string): Found => {
    if (raw[canonical] && typeof raw[canonical] === 'object') return { value: raw[canonical] as TargetMetrics, ambiguous: false };
    const hits = Object.keys(raw).filter(
      k => k !== 'targetA' && k !== 'targetB' && lower(k) === lower(label) && raw[k] && typeof raw[k] === 'object'
    );
    if (hits.length === 1) return { value: raw[hits[0]] as TargetMetrics, ambiguous: false };
    return { value: undefined, ambiguous: hits.length > 1 };
  };

  const a = find('targetA', targetALabel);
  const b = find('targetB', targetBLabel);

  const reasons: string[] = [];
  if (ambiguousLabels) reasons.push(`target labels are identical ("${targetALabel}")`);
  if (a.ambiguous || b.ambiguous) reasons.push('a label matched more than one JSON key');
  if (!a.value) reasons.push('no score found for targetA');
  if (!b.value) reasons.push('no score found for targetB');
  if (a.value && b.value && a.value === b.value) reasons.push('targetA and targetB resolved to the same object');

  const metrics: V2ComparisonMetrics = {
    targetA: a.value ?? fallback.targetA,
    targetB: b.value ?? fallback.targetB,
    gca: raw.gca ?? fallback.gca,
    codeRabbit: raw.codeRabbit ?? fallback.codeRabbit,
    overlapMatrix: raw.overlapMatrix ?? fallback.overlapMatrix,
  };
  return reasons.length ? { metrics, plausible: false, reason: reasons.join('; ') } : { metrics, plausible: true };
}

// Back-compat wrapper: the metrics alone. Callers that must know whether the result can be trusted
// use resolveV2Metrics().
export function normalizeV2Metrics(
  raw: any,
  targetALabel: string,
  targetBLabel: string,
  fallback: V2ComparisonMetrics
): V2ComparisonMetrics {
  return resolveV2Metrics(raw, targetALabel, targetBLabel, fallback).metrics;
}

export async function compareResultsWithLLMV2(
  prUrl: string, 
  targetAFindings: ReviewFinding[], 
  targetBFindings: ReviewFinding[],
  gcaFindings: ReviewFinding[],
  codeRabbitFindings: ReviewFinding[],
  targetALabel: string,
  targetBLabel: string,
  opts: { model?: string } = {}
): Promise<V2ComparisonResult> {
  const judgeModel = resolveJudgeModel(opts.model);
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
IMPORTANT: the JSON keys must be the LITERAL strings "targetA" and "targetB" exactly as
shown above — NOT "${targetALabel}" and "${targetBLabel}". Use ${targetALabel}/${targetBLabel}
only in the prose report; the JSON block always uses targetA/targetB regardless of what the
tools are called above.
`;

  try {
    console.log(`Asking Gemini to evaluate the V2 comparison...`);
    const response = await trackGeminiCall({ callType: 'llm_compare_v2', model: judgeModel }, () => ai.models.generateContent({
      model: judgeModel,
      contents: prompt,
      config: { temperature: 0.2 }
    }));

    if (!response.text) throw new Error('LLM returned empty text');

    let metrics: V2ComparisonMetrics;
    const emptyTarget = { actionability: 0, falsePositives: 0, uniqueFindings: 0 };
    const emptyMetrics = { targetA: { ...emptyTarget }, targetB: { ...emptyTarget }, gca: { ...emptyTarget }, codeRabbit: { ...emptyTarget }, overlapMatrix: { targetA_targetB: 0, targetA_gca: 0, targetA_codeRabbit: 0, targetB_gca: 0, targetB_codeRabbit: 0, gca_codeRabbit: 0 } };

    let resolution: ResolvedV2Metrics;
    try {
      const jsonMatch = response.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        const raw = JSON.parse(jsonMatch[1]);
        resolution = resolveV2Metrics(raw, targetALabel, targetBLabel, emptyMetrics);
      } else {
        resolution = { metrics: emptyMetrics, plausible: false, reason: 'no ```json block in the judge response' };
      }
    } catch(e) {
      resolution = { metrics: emptyMetrics, plausible: false, reason: 'judge JSON block did not parse' };
    }
    metrics = resolution.metrics;

    const countsPlausible =
      metrics.targetA.uniqueFindings <= targetAFindings.length &&
      metrics.targetB.uniqueFindings <= targetBFindings.length &&
      metrics.gca.uniqueFindings <= gcaFindings.length &&
      metrics.codeRabbit.uniqueFindings <= codeRabbitFindings.length;
    const plausible = resolution.plausible && countsPlausible;
    const implausibleReason = plausible
      ? undefined
      : [resolution.reason, countsPlausible ? undefined : 'uniqueFindings exceeds the number of findings that target actually had']
          .filter(Boolean).join('; ');
    if (!plausible) {
      console.warn(
        `⚠️ [V2] Judge scores for ${prUrl} are implausible (${implausibleReason}) — ` +
        `treat as unreliable and exclude from aggregates.`
      );
    }

    console.log(`✅ V2 Evaluation complete.`);
    return { report: response.text, metrics, plausible, implausibleReason, judgeModel, judgeServedModel: (response as any).modelVersion || undefined };
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
  llmAggregatedMetrics: any,
  // review-quality-design.md §7.3: GSR's OWN internal subagent-vs-basic
  // comparison (the Evaluator, §3.1), one entry per target per PR where it
  // was recorded — independent of the targetALabel/targetBLabel comparison
  // this whole function is otherwise about. Optional/defaults to [] so
  // existing callers (and the v1 generateAggregateReport, unchanged) don't
  // need updating.
  basicVsSubagentReports: string[] = []
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

<SUBAGENT_VS_BASIC_REPORTS>
${basicVsSubagentReports.length > 0
  ? basicVsSubagentReports.join('\n\n================================\n\n')
  : '(none recorded this run)'}
</SUBAGENT_VS_BASIC_REPORTS>

Your task is to synthesize these individual PR reports and metrics into a single, cohesive Executive Summary.
Highlight common strengths, consistent weaknesses, and compare performance between ${targetALabel} and ${targetBLabel}.

CRITICAL: You MUST include an explicit, easy-to-read "Metrics Comparison Matrix" (Markdown Table) at the very top of your executive summary before diving into the qualitative discussion.
The table MUST include 5 columns: Metric, ${targetALabel}, ${targetBLabel}, Gemini Code Assist, and CodeRabbit.
It should summarize Total Findings, Average Actionability, Total False Positives, and Unique Findings using the provided <AGGREGATE_METRICS> and <LLM_COMPARISON_METRICS>. Note: "Total False Positives" includes both diff-validation hallucinations and logic hallucinations identified by the evaluator.

You must also include an explicit 4x4 "Overlap Matrix" below the main metrics. The Overlap Matrix MUST mathematically display the pairwise overlap intersections sourced directly from the "overlapMatrix" section of the <LLM_COMPARISON_METRICS>. The columns and rows of this matrix should be the 4 targets (${targetALabel}, ${targetBLabel}, Gemini Code Assist, CodeRabbit). The intersection values represent how many bugs both targets successfully flagged.

<SUBAGENT_VS_BASIC_REPORTS> is a SEPARATE comparison from the ${targetALabel}/${targetBLabel} one above: for each target, GSR itself internally ran BOTH of its two review modes (a specialized subagent swarm, and a single general-purpose "basic" prompt) on the same PR and compared them — this measures GSR's two review MODES against each other, not this run's deployment targets. If <SUBAGENT_VS_BASIC_REPORTS> is not "(none recorded this run)", you MUST include a dedicated "### Subagent vs. Basic Mode" section synthesizing it, with particular attention to Logic/Correctness-category findings specifically: a prior production audit (job_tracker, a real consumer of GSR) found Logic/Correctness is GSR's structurally weakest review category, so state plainly, based on these reports, whether the subagent swarm's specialized agents actually catch more Logic/Correctness issues than the basic single-prompt mode, or not. If it IS "(none recorded this run)", state that no subagent-vs-basic data was available and omit the rest of that section rather than inventing a comparison.

Format your output in clean Markdown.
`;

  try {
    console.log(`Asking Gemini to generate an aggregate V2 evaluation summary...`);
    const response = await trackGeminiCall({ callType: 'llm_compare_v2_aggregate', model: MODEL_NAME }, () => ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: { temperature: 0.2 }
    }));

    if (!response.text) throw new Error('LLM returned empty text for aggregate report');
    console.log(`✅ Aggregate V2 evaluation complete.`);
    return response.text;
  } catch (err) {
    console.error('Failed to run aggregate LLM Comparison.', err);
    throw err;
  }
}
