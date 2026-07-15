import express from 'express';
import cors from 'cors';
import { runEvaluation } from './evaluate';
import { isValidInternalKey } from './internalAuth';

const app = express();
app.use(cors());
app.use(express.json());

// Main Evaluation Trigger Endpoint
app.post('/api/evaluate', async (req, res) => {
  if (!isValidInternalKey(req.header('X-Internal-Key'), process.env.EVALUATOR_SHARED_SECRET)) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const { comparisonGroup, targetBranch, useNewMetrics } = req.body;

  try {
    console.log(`[EVALUATOR] Triggering evaluation run...`);
    // Run asynchronously or await. For a long-running deployment with potentially long execution,
    // a background task approach or long-polling is needed. For simplicity, we'll await if it
    // finishes within the platform's request timeout, but the evaluation process might take
    // multiple minutes, so this assumes a generous timeout is configured on the host.
    const result = await runEvaluation({
      compGroup: comparisonGroup,
      targetBranch: targetBranch,
      useNewMetrics: useNewMetrics === true || useNewMetrics === 'true',
    });

    res.json(result);
  } catch (err: any) {
    console.error('[EVALUATOR] Evaluation failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Health check endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'healthy', service: 'gsr-evaluator' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 GSR Evaluator Service listening on port ${PORT}`);
});
