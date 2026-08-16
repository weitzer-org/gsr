import * as fs from 'fs';
import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { shouldFailOnSeverity } from './severityGate';
import { resolveAgentSelectionForMode } from './agentSelection';
import { setUsageSink, UsageRecord, aggregate, formatUsageSummaryMarkdown } from './usage';
import { reportUsage } from './usageReporter';
import { runFeedbackPass, FeedbackPassResult, formatFeedbackSummaryMarkdown } from './feedbackLoop';
import { resolveFeedbackLoopMode, resolveFeedbackMinConfidence, resolveFeedbackMaxReplies } from './feedbackConfig';

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

// writeFeedbackJobSummary writes Phase 1's report to the same Job Summary
// the usage rollup goes to. A `mode: 'off'` result (the input default) is
// intentionally skipped rather than writing a "disabled" line every run —
// that would just be noise for the vast majority of consumers who haven't
// opted in.
function writeFeedbackJobSummary(result: FeedbackPassResult): void {
  if (result.mode === 'off' || !process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatFeedbackSummaryMarkdown(result) + '\n');
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

async function main() {
  const collectedUsage: UsageRecord[] = [];
  setUsageSink(record => {
    collectedUsage.push(record);
  });

  let feedbackResult: FeedbackPassResult | undefined;

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
    feedbackResult = await runFeedbackPass(ghClient, url, {
      mode: feedbackMode,
      // currentDiff is already fetched above regardless of feedback-loop
      // mode — passing it through costs nothing and is only actually used
      // by 'respond' mode's adjudication stage (design doc §8.3 item 3).
      currentDiff: chunks,
      minConfidence: resolveFeedbackMinConfidence(),
      maxRepliesPosted: resolveFeedbackMaxReplies(),
    });
    if (!feedbackResult.skipped) {
      const adjudicatedNote = feedbackMode === 'respond' ? `, adjudicated ${feedbackResult.repliesAdjudicated} rejection(s)` : '';
      console.log(`[GSR Action] Feedback loop: scanned ${feedbackResult.threadsScanned} thread(s), classified ${feedbackResult.repliesClassified} repl(y/ies)${adjudicatedNote}, ${feedbackResult.findings.length} finding(s) with new activity.`);
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

    const orchestrator = new Orchestrator(5, modeConfig.promptsDir, modeConfig.useDedup, selectedAgents);
    orchestrator.onProgress = (agentName, file, status) => {
      console.log(`[GSR Action][${agentName}] ${file} — ${status}`);
    };

    const result = await orchestrator.runReview(activeChunks);
    console.log(`[GSR Action] Review complete: ${result.findings.length} finding(s), ${result.metrics.calls} model call(s).`);

    const { posted, skipped } = await ghClient.postReviewComments(url, result.findings);
    console.log(`[GSR Action] Posted ${posted} inline comment(s)${skipped > 0 ? `, skipped ${skipped}` : ''}.`);

    if (shouldFailOnSeverity(result.findings, failOnSeverity)) {
      throw new Error(`Found finding(s) at or above severity "${failOnSeverity}" — failing the workflow.`);
    }
  } finally {
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
    await maybeReportUsage(collectedUsage).catch(err => console.warn('[GSR Action] Failed to report usage:', err));
  }
}

main().catch(err => {
  console.error('[GSR Action] Failed:', err.message || err);
  process.exit(1);
});
