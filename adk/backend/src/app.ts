import express from 'express';
import cors from 'cors';
import { uploadJson, listFiles, getFileStream } from './storage';
import path from 'path';
import { spawn, exec } from './cmd.js';
import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { Evaluator } from './evaluator';
import { ReviewSource } from './types';
import { requireAuth, handleLogin, handleLogout } from './auth';
import { isValidUsageIngestKey } from './usageIngestAuth';
import { ingestUsageRecords, UsageRecord, getOrBuildDayRollup, sumRollups, currentDateString, Rollup } from './usage';
import { PromisePool } from './pool';
import { runFeedbackPass, escapeFeedbackResultForApiResponse } from './feedbackLoop';
import { isValidFeedbackRequest } from './feedbackAuth';
import { ingestFeedbackBody, listFeedbackFiles, getFeedbackRecordStream } from './feedback';

const SYSTEM_PROMPTS_DIR = process.env.SYSTEM_PROMPTS_DIR || 'system_prompts';
const BASIC_PROMPT_DIR = 'basic_prompt';
const frontendPath = path.join(process.cwd(), '../frontend');

export const app = express();
app.use(cors());

// Log all API requests to the terminal
app.use((req, res, next) => {
  console.log(`[Backend API] ${req.method} ${req.url}`);
  next();
});

const MAX_USAGE_INGEST_RECORDS = 500;

// Public (no UI_PASSWORD session) — used by GSR Action runs reporting usage
// from a consumer's own runner. Protected by its own shared-secret check
// instead, since it must stay reachable by consumers who never have a
// session cookie. See usageIngestAuth.ts for why this fails closed instead
// of following tools/eval's "open when unset" convention.
//
// Registered — with its own body parser — before the app-wide
// express.json() below, so only this route gets a bumped 2mb body limit (a
// full usage-ingest batch is bigger than every other route's tiny
// control-plane payload); every other pre-auth route keeps Express's
// smaller 100kb default. The key check runs as its own middleware ahead of
// the parser, so an unauthenticated/wrong-key request is rejected before
// any of its body is parsed.
app.post(
  '/api/usage/ingest',
  (req, res, next) => {
    if (!isValidUsageIngestKey(req.header('X-Usage-Ingest-Key'), process.env.USAGE_INGEST_SHARED_SECRET)) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    next();
  },
  express.json({ limit: '2mb' }),
  async (req, res) => {
    const { repository, records } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ status: 'error', message: '"records" must be a non-empty array.' });
    }
    if (records.length > MAX_USAGE_INGEST_RECORDS) {
      return res.status(400).json({ status: 'error', message: `Too many records (max ${MAX_USAGE_INGEST_RECORDS} per request).` });
    }

    try {
      const result = await ingestUsageRecords(records as UsageRecord[], {
        repository: typeof repository === 'string' ? repository : undefined,
      });
      res.json({ status: 'ok', ...result });
    } catch (error: any) {
      console.error('Error ingesting usage records:', error);
      res.status(500).json({ status: 'error', message: error.message || 'Internal server error' });
    }
  }
);

// Public-ish (either FEEDBACK_SHARED_SECRET header or a UI_PASSWORD session
// cookie — see feedbackAuth.ts) — the general-purpose finding-feedback push
// endpoint (finding-feedback-requirements.md §5, §6), and this repo's own
// PR-comment-feedback-loop Phase 3 export sink (pr-comment-feedback-loop-
// design.md §11: "the right sink... don't build a second one").
//
// Registered — with its own body parser — before the app-wide express.json()
// below, same reasoning as /api/usage/ingest: the auth check runs ahead of
// the parser, so an unauthenticated/wrong-key request is rejected before any
// of its body is parsed. 200kb mirrors §5.4's overall-request-body cap
// directly (not usage-ingest's bumped 2mb — a feedback submission is a few
// short fields plus optional code snippets, not a full usage batch).
app.post(
  '/api/findings/feedback',
  (req, res, next) => {
    if (!isValidFeedbackRequest(req.header('X-Feedback-Key'), req.headers.cookie)) {
      return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }
    next();
  },
  express.json({ limit: '200kb' }),
  async (req, res) => {
    try {
      const result = await ingestFeedbackBody(req.body);
      if ('error' in result) {
        return res.status(400).json({ status: 'error', message: result.error });
      }
      res.json({ status: 'ok', ...result });
    } catch (error: any) {
      console.error('Error ingesting finding feedback:', error);
      res.status(500).json({ status: 'error', message: error.message || 'Internal server error' });
    }
  }
);

app.use(express.json());

app.get('/api/status', (req, res) => {
  const isConnected = !!process.env.GEMINI_API_KEY;
  const modelStr = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

  res.json({
    status: 'success',
    geminiConnected: isConnected,
    model: modelStr
  });
});

// --- Auth (defined before the requireAuth gate below, so these stay public) ---
app.get('/login', (req, res) => res.sendFile(path.join(frontendPath, 'login.html')));
app.post('/login', handleLogin);
app.post('/logout', handleLogout);

// Everything below this point requires a valid session when UI_PASSWORD is set.
app.use(requireAuth);

app.get('/api/agents', (req, res) => {
  try {
    const agents = Orchestrator.listAgents(SYSTEM_PROMPTS_DIR);
    res.json({ agents });
  } catch (error: any) {
    console.error('Error listing agents:', error);
    res.status(500).json({ error: error.message || 'Failed to list agents' });
  }
});

app.post('/api/review', async (req, res) => {
  const { url, pat, agents, feedbackPass } = req.body;

  if (!url || !pat) {
    return res.status(400).json({ error: 'GitHub PR URL and PAT are required.' });
  }

  console.log(`Received review request for: ${url}`);

  try {
    let selectedAgents: string[] | undefined;
    if (agents !== undefined) {
      if (!Array.isArray(agents) || agents.some((a: unknown) => typeof a !== 'string')) {
        return res.status(400).json({ error: '"agents" must be an array of agent ID strings.' });
      }
      const normalized = Array.from(new Set(agents.map((a: string) => a.trim().toLowerCase()).filter(id => id !== '')));
      if (normalized.length === 0) {
        return res.status(400).json({ error: 'Select at least one agent.' });
      }
      const availableIds = new Set(Orchestrator.listAgentIds(SYSTEM_PROMPTS_DIR));
      const unknown = normalized.filter(id => !availableIds.has(id));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `Unknown agent id(s): ${unknown.join(', ')}` });
      }
      selectedAgents = normalized;
    }

    const ghClient = new GitHubClient(pat);
    const useDeduplicator = process.env.USE_DEDUPLICATOR !== 'false';
    const subagentOrchestrator = new Orchestrator(5, SYSTEM_PROMPTS_DIR, useDeduplicator, selectedAgents);
    // useDedup: false (basic mode shouldn't deduplicate), aggregateChunks:
    // true (review-quality-design.md §5.1 — still give it full cross-file
    // context within the PR, independent of skipping the dedup pass)
    const basicOrchestrator = new Orchestrator(5, BASIC_PROMPT_DIR, false, undefined, true);

    console.log(`Fetching diff for ${url}...`);
    const chunks = await ghClient.getPRDiff(url);
    console.log(`Found ${chunks.length} modified files in PR (post-filter).`);

    // PR comment feedback loop, Phase 1 ("observe") — forced to 'observe'
    // regardless of the requested mode (pr-comment-feedback-loop-design.md
    // §3.2, §7.3): this path posts findings under the human PAT-holder's
    // own GitHub identity, and posting a rebuttal here would read as if
    // that person wrote it. Only the Action (github-actions[bot]) is
    // permitted to post; the hosted backend only ever observes and reports.
    // Opt-in per request (`feedbackPass: true` in the body) since it spends
    // the requester's own Gemini quota. runFeedbackPass never throws, so
    // this can't turn a feedback-loop hiccup into a failed review.
    // Phase 2b (real posting, gated by `postRebuttals`) is deliberately
    // never passed here — mode never reaches 'respond' either, so
    // runAdjudicationStage/runPostingStage never run on this surface at
    // all; this is belt-and-suspenders, not the only protection.
    const feedbackResultRaw = await runFeedbackPass(ghClient, url, { mode: feedbackPass ? 'observe' : 'off' });
    // HTML-entity-escaped once here, right at the boundary where this
    // result becomes part of an HTTP JSON response a browser will parse —
    // see feedbackLoop.ts's groupByFinding for why this isn't baked into
    // the shared report shape itself (it's also consumed by the
    // Markdown-only Job Summary formatter on the Action surface, which
    // doesn't want HTML entities).
    const feedbackResult = escapeFeedbackResultForApiResponse(feedbackResultRaw);

    let activeChunks = chunks;
    let truncationWarning = '';

    const MAX_FILES = parseInt(process.env.MAX_REVIEW_FILES || '300', 10);
    if (activeChunks.length > MAX_FILES) {
      console.warn(`⚠️ PR ${url} has ${activeChunks.length} files. Truncating down to ${MAX_FILES}...`);
      truncationWarning = `PR exceeded configured limits. Only the first ${MAX_FILES} files were analyzed.`;
      activeChunks = activeChunks.slice(0, MAX_FILES);
    }

    // Defensive Limits: Gemini 2.5 API natively rejects >10MB
    const MAX_BYTE_SIZE = 9000000; // ~9.0MB ceiling
    const payloadSize = Buffer.byteLength(JSON.stringify(activeChunks), 'utf8');

    if (payloadSize > MAX_BYTE_SIZE) {
      console.warn(`⚠️ PR ${url} rejected. Final Payload Size: ${(payloadSize / 1024 / 1024).toFixed(2)}MB.`);
      return res.status(400).json({ 
          error: `Pull Request patch size is too massive for reliable automated review (Size: ${(payloadSize / 1024 / 1024).toFixed(2)}MB). Please split your commits.` 
      });
    }

    console.log(`Starting concurrent agent execution...`);

    // Set headers for NDJSON streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Broadcast truncation warning natively over NDJSON if applicable
    if (truncationWarning) {
      res.write(JSON.stringify({ type: 'warning', message: truncationWarning }) + '\n');
    }

    // Feedback loop result, if requested — streamed as its own frame type
    // (design doc §3.1) rather than folded into 'progress'/'warning', since
    // it isn't per-agent progress or an error condition.
    if (feedbackPass) {
      res.write(JSON.stringify({ type: 'feedback', ...feedbackResult }) + '\n');
    }

    subagentOrchestrator.onProgress = (agentName, file, status) => {
      console.log(`[Subagent: ${agentName}] - ${file} - Status: ${status}`);
      res.write(JSON.stringify({ type: 'progress', source: ReviewSource.SUBAGENT, agent: agentName, file, status }) + '\n');
    };

    basicOrchestrator.onProgress = (agentName, file, status) => {
      console.log(`[Basic: ${agentName}] - ${file} - Status: ${status}`);
      res.write(JSON.stringify({ type: 'progress', source: ReviewSource.BASIC, agent: agentName, file, status }) + '\n');
    };

    // Run both orchestrators concurrently using Promise.allSettled to ensure independence
    const results = await Promise.allSettled([
      subagentOrchestrator.runReview(activeChunks),
      basicOrchestrator.runReview(activeChunks)
    ]);

    const subagentResult = results[0].status === 'fulfilled' ? results[0].value : { findings: [], metrics: { inputTokens: 0, outputTokens: 0, calls: 0 } };
    const basicResult = results[1].status === 'fulfilled' ? results[1].value : { findings: [], metrics: { inputTokens: 0, outputTokens: 0, calls: 0 } };

    // Tag findings with source cleanly to avoid mutating the original arrays
    const subagentFindingsWithSource = subagentResult.findings.map(f => ({ ...f, source: ReviewSource.SUBAGENT }));
    const basicFindingsWithSource = basicResult.findings.map(f => ({ ...f, source: ReviewSource.BASIC }));

    console.log(`Review complete. Subagents found ${subagentResult.findings.length} issues, Basic found ${basicResult.findings.length} issues.`);
    
    // Evaluate comparison
    console.log(`Evaluating comparison...`);
    const evaluator = new Evaluator();
    // Pass original unmutated findings to evaluator
    const evaluationText = await evaluator.evaluateComparison(subagentResult.findings, basicResult.findings);

    // Merge findings and metrics efficiently
    const allFindings = subagentFindingsWithSource.concat(basicFindingsWithSource);
    const combinedMetrics = {
       inputTokens: subagentResult.metrics.inputTokens + basicResult.metrics.inputTokens,
       outputTokens: subagentResult.metrics.outputTokens + basicResult.metrics.outputTokens,
       calls: subagentResult.metrics.calls + basicResult.metrics.calls,
       subagentMetrics: subagentResult.metrics,
       basicMetrics: basicResult.metrics
    };

    const currentTimestamp = new Date().toISOString();

    const finalPayload = {
      type: 'done',
      url: url,
      timestamp: currentTimestamp,
      findings: allFindings,
      metrics: combinedMetrics,
      evaluation: evaluationText,
      // Only included when actually requested — omitted (not just
      // mode:'off') so old review-history records and new ones that never
      // opted in stay indistinguishable from "feature doesn't exist here".
      ...(feedbackPass ? { feedback: feedbackResult } : {})
    };

    res.write(JSON.stringify(finalPayload) + '\n');
    res.end();

    // Upload to object storage asynchronously
    try {
      const safeUrl = url.replace(/[^a-zA-Z0-9]/g, '-');
      const filename = `review-run_${currentTimestamp.replace(/[:.]/g, '-')}_${safeUrl}.json`;
      await uploadJson(getReviewBucketName(), filename, finalPayload, { originalUrl: url });
      console.log(`Successfully uploaded review history to storage: ${filename}`);
    } catch (uploadError) {
      console.error('Failed to upload review history to storage:', uploadError);
    }

  } catch (error: any) {
    console.error('Error during review:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error' });
    } else {
      res.write(JSON.stringify({ type: 'error', error: error.message || 'Internal server error' }) + '\n');
      res.end();
    }
  }
});

// --- Evals API ---
app.post('/api/evals/start', (req, res, next) => {
  try {
    const { comparisonGroup = 'local_vs_production', branchName, evalVersion = 'v2', evalRunner = 'local' } = req.body || {};

    if (comparisonGroup.includes('branch') && !branchName) {
      return res.status(400).json({ error: 'branchName is required when comparison group involves a branch.' });
    }

    if (evalRunner === 'production') {
      const prodUrl = process.env.EVALUATOR_SERVICE_URL;
      if (!prodUrl) {
         return res.status(400).json({ error: 'Production evaluation requires EVALUATOR_SERVICE_URL environment variable.' });
      }
      console.log(`[Backend API] Triggering remote evaluation harness at ${prodUrl}...`);
      
      // Fire-and-forget remote fetch
      fetch(`${prodUrl.replace(/\/$/, '')}/api/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.EVALUATOR_SHARED_SECRET ? { 'X-Internal-Key': process.env.EVALUATOR_SHARED_SECRET } : {})
        },
        body: JSON.stringify({ comparisonGroup, targetBranch: branchName, useNewMetrics: evalVersion === 'v2' })
      }).catch(err => console.error('Cloud Run Evaluator Trigger Failed:', err));

      return res.status(202).json({ status: 'started', message: 'Evaluation harness is running remotely on Cloud Run.' });
    }

    console.log(`[Backend API] Starting local evaluation harness... (Group: ${comparisonGroup}, Branch: ${branchName || 'N/A'})`);
    
    // Spawn the eval script detached so it doesn't block
    const evalDir = path.resolve(process.cwd(), '../../tools/eval');
    
    const runArgs = ['run', 'eval'];
    if (evalVersion === 'v2') {
        runArgs.push('--');
        runArgs.push('--use-new-metrics');
    }

    const child = spawn('npm', runArgs, {
      cwd: evalDir,
      detached: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        EVAL_COMPARISON_GROUP: comparisonGroup,
        EVAL_TARGET_BRANCH: branchName || ''
      }
    });
    
    child.unref(); // prevent waiting for this child
    res.status(202).json({ status: 'started', message: 'Evaluation harness is running in the background.' });
  } catch(e) {
    console.error('ERROR INSIDE POST API:', e);
    next(e);
  }
});

const getBucketName = () => process.env.S3_BUCKET || 'gsr-eval-results';
const getReviewBucketName = () => process.env.S3_REVIEW_BUCKET || 'gsr-review-results';

app.get('/api/evals/results', async (req, res) => {
  try {
    const files = await listFiles(getBucketName(), 'eval-run_', { maxResults: 100 });

    // Sort by updated descending
    files.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());

    res.json(files);
  } catch (error: any) {
    console.error('Error fetching eval results list:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/evals/results/:id', async (req, res) => {
  const fileId = req.params.id;

  // Defense-in-depth: Strict regex sanitization to prevent Path Traversal
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileId) || fileId.includes('..') || !fileId.startsWith('eval-run_')) {
    return res.status(400).json({ error: 'Invalid file ID format.' });
  }

  try {
    const stream = await getFileStream(getBucketName(), fileId);

    res.setHeader('Content-Type', 'application/json');
    stream
      .on('error', (error: Error) => {
        console.error('Error streaming eval result file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
      })
      .pipe(res);
  } catch (error: any) {
    console.error('Error initializing eval result stream:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- Review History API ---
app.get('/api/review/history', async (req, res) => {
  try {
    const files = await listFiles(getReviewBucketName(), 'review-run_', { maxResults: 100, includeMetadata: true });

    const fileList = files.map(f => ({
      name: f.name,
      updated: f.updated,
      size: f.size,
      originalUrl: f.metadata?.originalUrl || f.metadata?.originalurl
    }));

    fileList.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());

    res.json(fileList);
  } catch (error: any) {
    console.error('Error fetching review history list:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/review/history/:id', async (req, res) => {
  const fileId = req.params.id;

  if (!/^[a-zA-Z0-9_.-]+$/.test(fileId) || fileId.includes('..')) {
    return res.status(400).json({ error: 'Invalid file ID format.' });
  }

  try {
    const stream = await getFileStream(getReviewBucketName(), fileId);

    res.setHeader('Content-Type', 'application/json');
    stream
      .on('error', (error: Error) => {
        console.error('Error streaming review history file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
      })
      .pipe(res);
  } catch (error: any) {
    console.error('Error initializing review history stream:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- Usage Summary API (dashboard read side) ---
// Behind the existing session gate (requireAuth, above) — a normal
// authenticated dashboard route, unrelated to POST /api/usage/ingest's
// shared-secret write path above.
const MAX_USAGE_SUMMARY_RANGE_DAYS = 92;
const USAGE_SUMMARY_CONCURRENCY = 10;
const USAGE_SUMMARY_GRANULARITIES = ['day', 'week', 'month'] as const;
const USAGE_SUMMARY_SOURCES = ['all', 'backend', 'eval-harness'] as const;
type UsageSummaryGranularity = typeof USAGE_SUMMARY_GRANULARITIES[number];
type UsageSummarySource = typeof USAGE_SUMMARY_SOURCES[number];

function isValidDateString(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86400000)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// isoWeekLabel returns "<ISO week-year>-W<01-53>" for a YYYY-MM-DD date,
// per the standard ISO-8601 week definition (weeks start Monday, week 1 is
// the week containing the year's first Thursday).
function isoWeekLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNr = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const weekNumber = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function bucketLabel(dateStr: string, granularity: UsageSummaryGranularity): string {
  if (granularity === 'month') return dateStr.slice(0, 7);
  if (granularity === 'week') return isoWeekLabel(dateStr);
  return dateStr;
}

// buildSourceRollups fetches (bounded-concurrency, mirroring ingestUsageRecords's
// PromisePool usage) one day-rollup per date from `bucket`, via usage.ts's
// self-healing getOrBuildDayRollup cache.
async function buildSourceRollups(dates: string[], bucket: string, today: string): Promise<Rollup[]> {
  const pool = new PromisePool(USAGE_SUMMARY_CONCURRENCY);
  return Promise.all(dates.map(date => pool.add(() => getOrBuildDayRollup(date, today, bucket))));
}

app.get('/api/usage/summary', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  const granularity = (typeof req.query.granularity === 'string' ? req.query.granularity : 'day') as UsageSummaryGranularity;
  const source = (typeof req.query.source === 'string' ? req.query.source : 'all') as UsageSummarySource;

  if (!isValidDateString(from) || !isValidDateString(to)) {
    return res.status(400).json({ error: '"from" and "to" are required and must be YYYY-MM-DD.' });
  }
  if (to < from) {
    return res.status(400).json({ error: '"to" must not be before "from".' });
  }
  if (!(USAGE_SUMMARY_GRANULARITIES as readonly string[]).includes(granularity)) {
    return res.status(400).json({ error: `"granularity" must be one of: ${USAGE_SUMMARY_GRANULARITIES.join(', ')}.` });
  }
  if (!(USAGE_SUMMARY_SOURCES as readonly string[]).includes(source)) {
    return res.status(400).json({ error: `"source" must be one of: ${USAGE_SUMMARY_SOURCES.join(', ')}.` });
  }

  const dates = datesBetween(from, to);
  if (dates.length > MAX_USAGE_SUMMARY_RANGE_DAYS) {
    return res.status(400).json({ error: `Range too large (max ${MAX_USAGE_SUMMARY_RANGE_DAYS} days).` });
  }

  try {
    const today = currentDateString();
    const backendRollups = source !== 'eval-harness' ? await buildSourceRollups(dates, getReviewBucketName(), today) : null;
    const evalRollups = source !== 'backend' ? await buildSourceRollups(dates, getBucketName(), today) : null;

    const perDateRollups = dates.map((date, i) => {
      const parts: Rollup[] = [];
      if (backendRollups) parts.push(backendRollups[i]);
      if (evalRollups) parts.push(evalRollups[i]);
      return sumRollups(date, parts);
    });

    const grouped = new Map<string, Rollup[]>();
    dates.forEach((date, i) => {
      const label = bucketLabel(date, granularity);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label)!.push(perDateRollups[i]);
    });

    const buckets = Array.from(grouped.entries()).map(([label, rollups]) => sumRollups(label, rollups));
    const total = sumRollups(`${from}..${to}`, perDateRollups);

    res.json({ granularity, source, buckets, total });
  } catch (error: any) {
    console.error('Error building usage summary:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// --- Finding Feedback API (read side) ---
// Behind the existing session gate (requireAuth, above) — unlike the POST
// route above, this needs no dedicated auth of its own (finding-feedback-
// requirements.md §6: "auth via existing session"). Mirrors /api/review/
// history's list+detail shape exactly.
app.get('/api/findings/feedback', async (req, res) => {
  try {
    const files = await listFeedbackFiles();
    files.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
    res.json(files);
  } catch (error: any) {
    console.error('Error fetching finding feedback list:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/findings/feedback/:id', async (req, res) => {
  const fileId = req.params.id;

  if (!/^[a-zA-Z0-9_.-]+$/.test(fileId) || fileId.includes('..') || !fileId.startsWith('feedback_')) {
    return res.status(400).json({ error: 'Invalid file ID format.' });
  }

  try {
    const stream = await getFeedbackRecordStream(fileId);

    res.setHeader('Content-Type', 'application/json');
    stream
      .on('error', (error: Error) => {
        console.error('Error streaming finding feedback file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
        else res.end(); // headers already sent — can't send a new status, but must still close the connection
      })
      .pipe(res);
  } catch (error: any) {
    console.error('Error initializing finding feedback stream:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Serve frontend static files
app.use(express.static(frontendPath));

// Fallback to index.html for SPA routing (ignore static asset extensions to allow 404s)
app.get(/^(?!\/.*\.[a-zA-Z0-9]+$).*$/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

