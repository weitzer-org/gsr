import express from 'express';
import cors from 'cors';
import path from 'path';

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
    const subagentOrchestrator = new Orchestrator(5, SYSTEM_PROMPTS_DIR); // Run 5 LLM requests concurrently
    const basicOrchestrator = new Orchestrator(5, BASIC_PROMPT_DIR);

    console.log(`Fetching diff for ${url}...`);
    const chunks = await ghClient.getPRDiff(url);
    console.log(`Found ${chunks.length} modified files in PR.`);

    console.log(`Starting concurrent agent execution...`);

    // Set headers for NDJSON streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

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
      subagentOrchestrator.runReview(chunks),
      basicOrchestrator.runReview(chunks)
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

// Serve frontend static files
const frontendPath = path.join(process.cwd(), '../frontend');
app.use(express.static(frontendPath));

// Fallback to index.html for SPA routing (ignore static asset extensions to allow 404s)
app.get(/^(?!\/.*\.[a-zA-Z0-9]+$).*$/, (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

