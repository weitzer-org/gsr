import * as fs from 'fs';
import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { shouldFailOnSeverity } from './severityGate';
import { resolveAgentSelectionForMode } from './agentSelection';
import { setUsageSink, UsageRecord, aggregate, formatUsageSummaryMarkdown } from './usage';
import { reportUsage } from './usageReporter';
import { runFeedbackPass, FeedbackPassResult, formatFeedbackSummaryMarkdown, buildFeedbackRecords } from './feedbackLoop';
import { resolveFeedbackLoopMode, resolveFeedbackMinConfidence, resolveFeedbackMaxReplies, resolveFeedbackPostEnabled, feedbackPostMisconfigurationWarning, resolveFeedbackReportConfig } from './feedbackConfig';
import { reportFeedback } from './feedbackReporter';
import { planRepost } from './repostSuppression';
import { parseLowPriorityPathPatterns } from './lowPriorityPaths';
import { ReviewResult } from './types';
import { Evaluator } from './evaluator';
import { resolveShadowMode, formatShadowReviewSummaryMarkdown, ReviewMode } from './shadowReview';

const MODE_CONFIG: Record<string, { promptsDir: string; useDedup: boolean }> = {
  subagent: { promptsDir: 'system_prompts', useDedup: true },
  basic: { promptsDir: 'basic_prompt', useDedup: false }
};

function resolvePullRequestUrl(): string {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is not set — this action must run inside a GitHub Actions workflow.');
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is not set — this action must run inside a GitHub Actions workflow.');
  }

  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pullNumber = event.pull_request?.number;
  if (!pullNumber) {
    throw new Error('No pull_request found in the GitHub event payload — this action only supports pull_request and pull_request_target events.');
  }

  return `https://github.com/${repository}/pull/${pullNumber}`;
}

// writeJobSummary always runs for a run that produced any usage (even one
// that ultimately fails the workflow via shouldFailOnSeverity) — usage was
// incurred either way. No-ops quietly when there's nothing to report or
// GITHUB_STEP_SUMMARY isn't set (e.g. local test runs).
function writeJobSummary(records: UsageRecord[]): void {
  if (records.length === 0 || !process.env.GITHUB_STEP_SUMMARY) return;
  const today = new Date().toISOString().slice(0, 10);
  const rollup = aggregate(today, records);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatUsageSummaryMarkdown(rollup) + '\n');
}

// writeReviewSummary (review-quality-design.md §10) surfaces the review's
// own wall-clock duration directly in this run's Job Summary — before this,
// basic-mode's real latency had to be pulled from Actions history after the
// fact (§10's 155s median / 169s average / 4s-462s range came from manually
// isolating 68 `gsr-review.yml` runs' timing, not from any data GSR itself
// recorded). result.metrics.durationMs is Orchestrator.runReview's own
// wall-clock, not a sum of individual Gemini call latencies (which
// understates it under concurrency — see types.ts's doc comment).
function writeReviewSummary(result: ReviewResult): void {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const seconds = (result.metrics.durationMs / 1000).toFixed(1);
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `**Review duration:** ${seconds}s — ${result.findings.length} finding(s), ${result.metrics.calls} model call(s).\n\n`
  );
}

// writeFeedbackJobSummary writes Phase 1's report to the same Job Summary
// the usage rollup goes to. A `mode: 'off'` result (the input default) is
// intentionally skipped rather than writing a "disabled" line every run —
// that would just be noise for the vast majority of consumers who haven't
// opted in.
function writeFeedbackJobSummary(result: FeedbackPassResult): void {
  if (result.mode === 'off' || !process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatFeedbackSummaryMarkdown(result) + '\n');
}

// writeShadowJobSummary (§3.1) writes the already-formatted shadow-review
// markdown (built in main() once the shadow orchestrator + Evaluator have
// both run) to this run's Job Summary. No-op when SHADOW_MODE wasn't set,
// the shadow orchestrator run failed (see main()'s Promise.all), or
// GITHUB_STEP_SUMMARY isn't set (e.g. local test runs) — in every one of
// those cases main() never calls this at all.
function writeShadowJobSummary(markdown: string): void {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

// maybeReportUsage is the opt-in, off-by-default centralized reporting path
// — see ACTION.md's "Usage reporting" section. No-ops unless both env vars
// are set, which only happens for repos the GSR maintainer has explicitly
// handed a working USAGE_INGEST_SHARED_SECRET to (mirroring how
// gemini-api-key is already supplied per-consumer, never baked into the
// public action image).
async function maybeReportUsage(records: UsageRecord[]): Promise<void> {
  const url = process.env.USAGE_INGEST_URL;
  const key = process.env.USAGE_INGEST_SHARED_SECRET;
  if (!url || !key || records.length === 0) return;
  await reportUsage(records, { url, key, repository: process.env.GITHUB_REPOSITORY });
}

// maybeReportFeedback is Stage 3 (design doc §7.2, §11.2) — the same
// opt-in, off-by-default shape as maybeReportUsage above: no-ops unless
// feedback-report-url and the shared secret are both configured. Only
// called with a real result (never on a mode: 'off'/skipped pass) and only
// when prUrl is known, since a FindingFeedback record's reviewUrl is
// required (finding-feedback-requirements.md §5.4).
async function maybeReportFeedback(result: FeedbackPassResult | undefined, prUrl: string | undefined): Promise<void> {
  if (!result || result.skipped || !prUrl) return;
  const config = resolveFeedbackReportConfig();
  if (!config) return;
  const records = buildFeedbackRecords(result, prUrl);
  if (records.length === 0) return;
  const { batchesSent, batchesFailed } = await reportFeedback(records, { url: config.url, key: config.key, reviewUrl: prUrl });
  console.log(`[GSR Action] Feedback report: ${records.length} record(s) in ${batchesSent} batch(es) sent, ${batchesFailed} failed.`);
}

async function main() {
  const collectedUsage: UsageRecord[] = [];
  setUsageSink(record => {
    collectedUsage.push(record);
  });

  let feedbackResult: FeedbackPassResult | undefined;
  let prUrl: string | undefined;
  // §3.1: set once (if at all) inside the try block below, once both the
  // shadow orchestrator and the Evaluator comparison have completed — read
  // in `finally` so it's still written even if a later step (e.g.
  // shouldFailOnSeverity) throws.
  let shadowSummaryMarkdown: string | undefined;
  // §10: set once the primary review completes — read in `finally`
  // alongside shadowSummaryMarkdown above, same reasoning.
  let reviewResultForSummary: ReviewResult | undefined;

  try {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN is required.');
    }
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required.');
    }

    const mode = (process.env.REVIEW_MODE || 'subagent').toLowerCase();
    const modeConfig = MODE_CONFIG[mode];
    if (!modeConfig) {
      throw new Error(`Invalid mode "${mode}" — must be "subagent" or "basic".`);
    }

    const failOnSeverity = process.env.FAIL_ON_SEVERITY || 'none';
    shouldFailOnSeverity([], failOnSeverity); // validates the threshold up front; throws before we burn a review on a typo

    const availableIds = mode === 'subagent' ? Orchestrator.listAgentIds(modeConfig.promptsDir) : [];
    const { selectedAgents, warning } = resolveAgentSelectionForMode(mode, process.env.REVIEW_AGENTS, availableIds);
    if (warning) {
      console.warn(warning);
    }

    const url = resolvePullRequestUrl();
    prUrl = url;
    const ghClient = new GitHubClient(githubToken);

    console.log(`[GSR Action] Fetching diff for ${url} (mode: ${mode})...`);
    const chunks = await ghClient.getPRDiff(url);
    console.log(`[GSR Action] Found ${chunks.length} reviewable file(s).`);

    // PR comment feedback loop, Phase 1 ("observe") — off by default, since
    // even observe mode spends the consumer's own Gemini quota. Runs before
    // the "no reviewable files" early return below: whether *this* push has
    // a diff to review is unrelated to whether a developer replied to a
    // *previous* finding, and runFeedbackPass never throws (see
    // feedbackLoop.ts), so it can't turn a no-op diff run into a failed one.
    const feedbackMode = resolveFeedbackLoopMode();
    const feedbackPostEnabled = resolveFeedbackPostEnabled();
    // Phase 2b's arm switch only does anything when mode is "respond" —
    // resolveFeedbackPostEnabled has no way to know that on its own, so the
    // cross-check lives in feedbackPostMisconfigurationWarning, where both
    // resolved values are available.
    const misconfigWarning = feedbackPostMisconfigurationWarning(feedbackMode, feedbackPostEnabled);
    if (misconfigWarning) console.warn(misconfigWarning);

    feedbackResult = await runFeedbackPass(ghClient, url, {
      mode: feedbackMode,
      // currentDiff is already fetched above regardless of feedback-loop
      // mode — passing it through costs nothing and is only actually used
      // by 'respond' mode's adjudication stage (design doc §8.3 item 3).
      currentDiff: chunks,
      minConfidence: resolveFeedbackMinConfidence(),
      maxRepliesPosted: resolveFeedbackMaxReplies(),
      postRebuttals: feedbackPostEnabled,
    });
    if (!feedbackResult.skipped) {
      const adjudicatedNote = feedbackMode === 'respond' ? `, adjudicated ${feedbackResult.repliesAdjudicated} rejection(s)` : '';
      const postingNote = feedbackResult.postingEnabled ? `, posted ${feedbackResult.repliesPosted} repl(y/ies) (${feedbackResult.repliesPostFailed} failed)` : '';
      console.log(`[GSR Action] Feedback loop: scanned ${feedbackResult.threadsScanned} thread(s), classified ${feedbackResult.repliesClassified} repl(y/ies)${adjudicatedNote}${postingNote}, ${feedbackResult.findings.length} finding(s) with new activity.`);
    }

    if (chunks.length === 0) {
      console.log('[GSR Action] No reviewable file changes — skipping review.');
      return;
    }

    const maxFiles = parseInt(process.env.MAX_REVIEW_FILES || '300', 10);
    const activeChunks = chunks.length > maxFiles ? chunks.slice(0, maxFiles) : chunks;
    if (chunks.length > maxFiles) {
      console.warn(`[GSR Action] PR has ${chunks.length} files; truncating to ${maxFiles}.`);
    }

    // aggregateChunks: true for both modes (review-quality-design.md §5.1) —
    // independent of useDedup, so basic mode still gets full cross-file
    // context within the PR even though it skips the dedup pass.
    // lowPriorityPathPatterns (§4.1): built-in defaults extended with
    // whatever the consuming repo added via low-priority-paths — never
    // replaced, see lowPriorityPaths.ts's module doc.
    const lowPriorityPathPatterns = parseLowPriorityPathPatterns(process.env.LOW_PRIORITY_PATHS);
    const orchestrator = new Orchestrator(5, modeConfig.promptsDir, modeConfig.useDedup, selectedAgents, true, lowPriorityPathPatterns);
    orchestrator.onProgress = (agentName, file, status) => {
      console.log(`[GSR Action][${agentName}] ${file} — ${status}`);
    };

    // SHADOW_MODE (review-quality-design.md §3.1, Gap 2 — "the subagent
    // swarm has no production usage data"): optionally runs a second,
    // NON-POSTING Orchestrator in the other mode purely to collect
    // comparison data. job_tracker's own opt-in label gate for the deep
    // (subagent) review has never once been applied across 19 real PRs
    // (§1/§3), so without this the swarm — this project's core
    // differentiator — has zero production signal on whether it actually
    // beats whichever mode a consumer really ships. Off by default
    // (resolveShadowMode returns undefined when SHADOW_MODE is unset);
    // roughly doubles this run's Gemini cost when enabled (§9 open
    // question 2) — this only builds/ships the capability, it does not
    // turn it on for any consumer.
    const shadowMode = resolveShadowMode(mode);
    let shadowOrchestrator: Orchestrator | undefined;
    if (shadowMode) {
      const shadowModeConfig = MODE_CONFIG[shadowMode];
      // Only "subagent" mode has a selectable agent set (mirrors the
      // primary mode's own availableIds/selectedAgents resolution above) —
      // REVIEW_AGENTS is the one shared input, applied to whichever of
      // {mode, shadowMode} is "subagent". No warning path needed here:
      // resolveAgentSelectionForMode only ever warns for the *other*
      // branch (mode !== 'subagent'), which this call never takes.
      const shadowSelectedAgents = shadowMode === 'subagent'
        ? resolveAgentSelectionForMode(shadowMode, process.env.REVIEW_AGENTS, Orchestrator.listAgentIds(shadowModeConfig.promptsDir)).selectedAgents
        : undefined;
      shadowOrchestrator = new Orchestrator(5, shadowModeConfig.promptsDir, shadowModeConfig.useDedup, shadowSelectedAgents, true, lowPriorityPathPatterns);
      shadowOrchestrator.onProgress = (agentName, file, status) => {
        console.log(`[GSR Action][Shadow:${agentName}] ${file} — ${status}`);
      };
      console.log(`[GSR Action] Shadow mode enabled: running "${shadowMode}" alongside posting mode "${mode}" for comparison (results are not posted).`);
    }

    // Repost-suppression (review-quality-design.md §2.1, addendum) — fetch
    // what GSR itself already posted on this PR in parallel with the (much
    // slower) Gemini review, so wall-clock isn't affected: this is a plain
    // GitHub REST read, independent of the review's outcome, reusing
    // listReviewThreads exactly as the PR-comment feedback loop already
    // does above rather than re-implementing comment pagination.
    //
    // Never let a failure here throw away an already-completed (and
    // already-paid-for) Gemini review: bundled into the same Promise.all as
    // orchestrator.runReview, an uncaught rejection would abort the whole
    // run and post nothing at all, despite the expensive part having
    // already succeeded. Degrades to "treat every finding as unseen" (i.e.
    // repost-suppression no-ops this run, identical to pre-this-feature
    // behavior) instead — mirrors feedbackLoop.ts's own pre-post
    // concurrency re-check, which wraps this exact same call the same way
    // ("posting will proceed without it").
    //
    // The shadow orchestrator's run (when enabled) is bundled into this
    // same Promise.all too, so it doesn't add serial wall-clock on top of
    // the posting review — same failure isolation as priorThreads: a
    // shadow-run failure degrades to "no shadow summary this run," never
    // to affecting the posting review's outcome.
    const [result, priorThreads, shadowResult] = await Promise.all([
      orchestrator.runReview(activeChunks),
      ghClient.listReviewThreads(url).catch(err => {
        console.warn('[GSR Action] Failed to fetch prior GSR review threads; repost suppression will be skipped this run:', err);
        return [];
      }),
      shadowOrchestrator
        ? shadowOrchestrator.runReview(activeChunks).catch(err => {
            console.warn('[GSR Action][Shadow] Shadow orchestrator failed; skipping shadow-mode summary this run:', err);
            return undefined;
          })
        : Promise.resolve(undefined),
    ]);
    console.log(`[GSR Action] Review complete: ${result.findings.length} finding(s), ${result.metrics.calls} model call(s).`);
    // Deferred to `finally` (with usage/feedback/shadow below) rather than
    // written here inline, purely so the Job Summary's sections come out
    // in one consistent, predictable order regardless of when in main()
    // each one is computed — not for correctness (nothing here depends on
    // later steps).
    reviewResultForSummary = result;

    // Reuses Evaluator (evaluator.ts) exactly as app.ts's web-UI dual-run
    // already does (§3.1) — purpose-built for this comparison, just never
    // wired into the Action path before now. Never throws (its own
    // try/catch returns an error string), so no extra guard needed here.
    if (shadowMode && shadowResult) {
      const subagentResult = mode === 'subagent' ? result : shadowResult;
      const basicResult = mode === 'basic' ? result : shadowResult;
      const evaluator = new Evaluator();
      const evaluationText = await evaluator.evaluateComparison(subagentResult.findings, basicResult.findings);
      shadowSummaryMarkdown = formatShadowReviewSummaryMarkdown(mode as ReviewMode, result, shadowMode, shadowResult, evaluationText);
      console.log(`[GSR Action] Shadow review complete: ${shadowResult.findings.length} finding(s), ${shadowResult.metrics.calls} model call(s) (not posted).`);
    }

    const { toPost, collapsedCount, markerOverrides } = planRepost(result.findings, priorThreads, activeChunks);
    const suppressedCount = result.findings.length - toPost.length - collapsedCount;
    if (suppressedCount > 0 || collapsedCount > 0) {
      console.log(`[GSR Action] Repost suppression: ${suppressedCount} unchanged finding(s) not reposted, ${collapsedCount} recurring finding(s) collapsed into the summary.`);
    }

    const { posted, skipped } = await ghClient.postReviewComments(url, toPost, {
      summaryTotalCount: result.findings.length,
      collapsedCount,
      markerOverrides,
    });
    console.log(`[GSR Action] Posted ${posted} inline comment(s)${skipped > 0 ? `, skipped ${skipped}` : ''}.`);

    if (shouldFailOnSeverity(result.findings, failOnSeverity)) {
      throw new Error(`Found finding(s) at or above severity "${failOnSeverity}" — failing the workflow.`);
    }
  } finally {
    if (reviewResultForSummary) {
      try {
        writeReviewSummary(reviewResultForSummary);
      } catch (err) {
        console.warn('[GSR Action] Failed to write review duration summary:', err);
      }
    }
    try {
      writeJobSummary(collectedUsage);
    } catch (err) {
      console.warn('[GSR Action] Failed to write usage job summary:', err);
    }
    if (feedbackResult) {
      try {
        writeFeedbackJobSummary(feedbackResult);
      } catch (err) {
        console.warn('[GSR Action] Failed to write feedback loop job summary:', err);
      }
    }
    if (shadowSummaryMarkdown) {
      try {
        writeShadowJobSummary(shadowSummaryMarkdown);
      } catch (err) {
        console.warn('[GSR Action] Failed to write shadow review job summary:', err);
      }
    }
    await maybeReportUsage(collectedUsage).catch(err => console.warn('[GSR Action] Failed to report usage:', err));
    await maybeReportFeedback(feedbackResult, prUrl).catch(err => console.warn('[GSR Action] Failed to report feedback:', err));
  }
}

main().catch(err => {
  console.error('[GSR Action] Failed:', err.message || err);
  process.exit(1);
});
