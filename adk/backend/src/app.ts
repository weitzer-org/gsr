import express from 'express';
import cors from 'cors';

import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';
import { Evaluator } from './evaluator';

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
    const subagentOrchestrator = new Orchestrator(5, 'system_prompts'); // Run 5 LLM requests concurrently
    const basicOrchestrator = new Orchestrator(5, 'basic_prompt');

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
      res.write(JSON.stringify({ type: 'progress', source: 'subagent', agent: agentName, file, status }) + '\n');
    };

    basicOrchestrator.onProgress = (agentName, file, status) => {
      console.log(`[Basic: ${agentName}] - ${file} - Status: ${status}`);
      res.write(JSON.stringify({ type: 'progress', source: 'basic', agent: agentName, file, status }) + '\n');
    };

    // Run both orchestrators concurrently
    const [subagentResult, basicResult] = await Promise.all([
      subagentOrchestrator.runReview(chunks),
      basicOrchestrator.runReview(chunks)
    ]);

    // Tag findings with source
    subagentResult.findings.forEach(f => f.source = 'subagent');
    basicResult.findings.forEach(f => f.source = 'basic');

    console.log(`Review complete. Subagents found ${subagentResult.findings.length} issues, Basic found ${basicResult.findings.length} issues.`);
    
    // Evaluate comparison
    console.log(`Evaluating comparison...`);
    const evaluator = new Evaluator();
    const evaluationText = await evaluator.evaluateComparison(subagentResult.findings, basicResult.findings);

    // Merge findings and metrics
    const allFindings = [...subagentResult.findings, ...basicResult.findings];
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
