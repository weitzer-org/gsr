import express from 'express';
import cors from 'cors';
import { Storage } from '@google-cloud/storage';
import path from 'path';
import { spawn, exec } from './cmd.js';
import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { Evaluator } from './evaluator';
import { ReviewSource } from './types';

const SYSTEM_PROMPTS_DIR = 'system_prompts';
const BASIC_PROMPT_DIR = 'basic_prompt';

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
  const modelStr = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  
  res.json({
    status: 'success',
    geminiConnected: isConnected,
    model: modelStr
  });
});

app.post('/api/review', async (req, res) => {
  const { url, pat } = req.body;

  if (!url || !pat) {
    return res.status(400).json({ error: 'GitHub PR URL and PAT are required.' });
  }

  console.log(`Received review request for: ${url}`);

  try {
    const ghClient = new GitHubClient(pat);
    const useDeduplicator = process.env.USE_DEDUPLICATOR !== 'false';
    const subagentOrchestrator = new Orchestrator(5, SYSTEM_PROMPTS_DIR, useDeduplicator);
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

    res.write(JSON.stringify({ 
      type: 'done', 
      findings: allFindings, 
      metrics: combinedMetrics,
      evaluation: evaluationText
    }) + '\n');
    res.end();
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
    const { comparisonGroup = 'local_vs_production', branchName } = req.body || {};

    if (comparisonGroup.includes('branch') && !branchName) {
      return res.status(400).json({ error: 'branchName is required when comparison group involves a branch.' });
    }

    console.log(`[Backend API] Starting evaluation harness... (Group: ${comparisonGroup}, Branch: ${branchName || 'N/A'})`);
    
    // Spawn the eval script detached so it doesn't block
    const evalDir = path.resolve(process.cwd(), '../../tools/eval');
    const child = spawn('npm', ['run', 'eval'], {
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

const getStorageInstance = () => new Storage();
const getBucketName = () => process.env.GCS_BUCKET || `gsr-eval-results-${process.env.GOOGLE_CLOUD_PROJECT || 'weitzer-org'}`;

app.get('/api/evals/results', async (req, res) => {
  try {
    const storage = getStorageInstance();
    const bucket = storage.bucket(getBucketName());
    const [files] = await bucket.getFiles({ prefix: 'eval-run_' });
    
    const fileList = files.map(f => ({
      name: f.name,
      updated: f.metadata.updated,
      size: f.metadata.size
    }));
    
    // Sort by updated descending
    fileList.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
    
    res.json(fileList);
  } catch (error: any) {
    console.error('Error fetching GCS list:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.get('/api/evals/results/:id', (req, res) => {
  const fileId = req.params.id;
  
  // Defense-in-depth: Strict regex sanitization to prevent Path Traversal
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileId) || fileId.includes('..')) {
    return res.status(400).json({ error: 'Invalid file ID format.' });
  }

  try {
    const storage = getStorageInstance();
    const bucket = storage.bucket(getBucketName());
    const file = bucket.file(fileId);
    
    res.setHeader('Content-Type', 'application/json');
    file.createReadStream()
      .on('error', (error) => {
        console.error('Error streaming GCS file:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
      })
      .pipe(res);
  } catch (error: any) {
    console.error('Error initializing GCS stream:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Serve frontend static files
const frontendPath = path.join(process.cwd(), '../frontend');
app.use(express.static(frontendPath));

// Fallback to index.html for SPA routing (ignore static asset extensions to allow 404s)
app.get(/^(?!\/.*\.[a-zA-Z0-9]+$).*$/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

