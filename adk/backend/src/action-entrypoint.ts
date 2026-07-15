import * as fs from 'fs';
import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { shouldFailOnSeverity } from './severityGate';

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

async function main() {
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

  const url = resolvePullRequestUrl();
  const ghClient = new GitHubClient(githubToken);

  console.log(`[GSR Action] Fetching diff for ${url} (mode: ${mode})...`);
  const chunks = await ghClient.getPRDiff(url);
  console.log(`[GSR Action] Found ${chunks.length} reviewable file(s).`);

  if (chunks.length === 0) {
    console.log('[GSR Action] No reviewable file changes — skipping review.');
    return;
  }

  const maxFiles = parseInt(process.env.MAX_REVIEW_FILES || '300', 10);
  const activeChunks = chunks.length > maxFiles ? chunks.slice(0, maxFiles) : chunks;
  if (chunks.length > maxFiles) {
    console.warn(`[GSR Action] PR has ${chunks.length} files; truncating to ${maxFiles}.`);
  }

  const orchestrator = new Orchestrator(5, modeConfig.promptsDir, modeConfig.useDedup);
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
}

main().catch(err => {
  console.error('[GSR Action] Failed:', err.message || err);
  process.exit(1);
});
