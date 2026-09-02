// SHADOW_MODE Action-input resolution + summary formatting (review-quality-
// design.md §3.1, Gap 2 — "the subagent swarm has no production usage
// data"). job_tracker's own opt-in label gate for `gsr-review-deep.yml` has
// never once been applied across 19 PRs (§1/§3's finding), so the swarm —
// this project's core differentiator — ships with zero real-world signal
// on whether it actually outperforms whichever mode a consumer really
// runs. SHADOW_MODE closes that data gap without touching the PR-facing
// behavior at all: it runs a second, NON-POSTING Orchestrator in the other
// mode purely for comparison, logged to this run's Job Summary.
//
// Split out of action-entrypoint.ts for the same reason feedbackConfig.ts
// is: resolveShadowMode and formatShadowReviewSummaryMarkdown are pure,
// side-effect-free functions, so they're unit-testable without importing
// action-entrypoint.ts (whose top-level `main().catch(...)` call runs on
// import — it's meant to be invoked as the Action's entrypoint script, not
// a library). The actual second Orchestrator/Evaluator run has real side
// effects (Gemini calls, real cost) and stays inline in action-entrypoint.ts,
// alongside the primary Orchestrator's own runReview call.
import { ReviewResult } from './types';

const REVIEW_MODES = ['subagent', 'basic'] as const;
export type ReviewMode = typeof REVIEW_MODES[number];

function isReviewMode(value: string): value is ReviewMode {
  return (REVIEW_MODES as readonly string[]).includes(value);
}

// resolveShadowMode validates SHADOW_MODE (the `shadow-mode` Action input,
// unset by default — shadow mode is off unless explicitly opted into,
// since it roughly doubles this run's Gemini cost, per §9 open question 2).
// Returns the mode to shadow-run non-posting, or undefined when shadow mode
// shouldn't run this run at all: unset/empty (the default — no warning,
// this is the common case), unrecognized (warns), or identical to the mode
// that's already posting (warns — shadow-running the exact same mode a
// second time would just double cost for a redundant comparison against
// itself). Mirrors resolveFeedbackLoopMode's (feedbackConfig.ts) "warn and
// fall back to a safe default" convention rather than failing the whole run
// over a typo in an opt-in input.
export function resolveShadowMode(primaryMode: string): ReviewMode | undefined {
  const raw = (process.env.SHADOW_MODE || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (!isReviewMode(raw)) {
    console.warn(`[GSR Action] Unrecognized shadow-mode "${raw}" — must be "subagent" or "basic". Skipping shadow review for this run.`);
    return undefined;
  }
  if (raw === primaryMode) {
    console.warn(`[GSR Action] shadow-mode "${raw}" is the same as mode "${primaryMode}" — shadow review would be redundant. Skipping.`);
    return undefined;
  }
  return raw;
}

// formatShadowReviewSummaryMarkdown renders the shadow-run comparison as
// GitHub-Flavored Markdown for $GITHUB_STEP_SUMMARY. Pure — independently
// testable from the file-writing side, which lives in action-entrypoint.ts
// (same split as usage.ts's formatUsageSummaryMarkdown and feedbackLoop.ts's
// formatFeedbackSummaryMarkdown). evaluationText is the Evaluator's
// (evaluator.ts) existing subagent-vs-basic comparison — already built for
// exactly this, just never wired into the Action path before this.
export function formatShadowReviewSummaryMarkdown(
  postingMode: ReviewMode,
  postingResult: ReviewResult,
  shadowMode: ReviewMode,
  shadowResult: ReviewResult,
  evaluationText: string
): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(`## GSR Shadow Review (${shadowMode})`);
  lines.push('');
  lines.push(
    `Ran an additional \`${shadowMode}\` review alongside the posting \`${postingMode}\` review, ` +
    `for comparison only — **none of this was posted to the PR**. See review-quality-design.md §3.1.`
  );
  lines.push('');
  lines.push(`| | Posted (\`${postingMode}\`) | Shadow (\`${shadowMode}\`) |`);
  lines.push('|---|---|---|');
  lines.push(`| Findings | ${postingResult.findings.length} | ${shadowResult.findings.length} |`);
  lines.push(`| Model calls | ${postingResult.metrics.calls} | ${shadowResult.metrics.calls} |`);
  lines.push(`| Duration | ${seconds(postingResult.metrics.durationMs)}s | ${seconds(shadowResult.metrics.durationMs)}s |`);
  lines.push('');
  lines.push('### Subagent vs. Basic comparison');
  lines.push('');
  lines.push(evaluationText);
  return lines.join('\n');
}
