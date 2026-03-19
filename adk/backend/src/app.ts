import express from 'express';
import cors from 'cors';

import { GitHubClient } from './github';
import { Orchestrator } from './orchestrator';

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
    const orchestrator = new Orchestrator(5); // Run 5 LLM requests concurrently

    console.log(`Fetching diff for ${url}...`);
    const chunks = await ghClient.getPRDiff(url);
    console.log(`Found ${chunks.length} modified files in PR.`);

    console.log(`Starting concurrent agent execution...`);

    // Set headers for NDJSON streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    orchestrator.onProgress = (agentName, file, status) => {
      console.log(`[Agent: ${agentName}] - ${file} - Status: ${status}`);
      res.write(JSON.stringify({ type: 'progress', agent: agentName, file, status }) + '\n');
    };

    const result = await orchestrator.runReview(chunks);
    console.log(`Review complete. Found ${result.findings.length} total issues.`);
    
    res.write(JSON.stringify({ type: 'done', findings: result.findings, metrics: result.metrics }) + '\n');
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
