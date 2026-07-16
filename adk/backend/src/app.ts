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

const SYSTEM_PROMPTS_DIR = process.env.SYSTEM_PROMPTS_DIR || 'system_prompts';
const BASIC_PROMPT_DIR = 'basic_prompt';
const frontendPath = path.join(process.cwd(), '../frontend');

export const app = express();
app.use(cors());
app.use(express.json());

// Log all API requests to the terminal
app.use((req, res, next) => {
  console.log(`[Backend API] ${req.method} ${req.url}`);
  next();
});

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
  const { url, pat, agents } = req.body;

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
    const basicOrchestrator = new Orchestrator(5, BASIC_PROMPT_DIR, false); // Basic orchestrator shouldn't deduplicate

    console.log(`Fetching diff for ${url}...`);
    const chunks = await ghClient.getPRDiff(url);
    console.log(`Found ${chunks.length} modified files in PR (post-filter).`);

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
      evaluation: evaluationText
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

// Serve frontend static files
app.use(express.static(frontendPath));

// Fallback to index.html for SPA routing (ignore static asset extensions to allow 404s)
app.get(/^(?!\/.*\.[a-zA-Z0-9]+$).*$/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

