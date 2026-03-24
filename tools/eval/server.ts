import express from 'express';
import cors from 'cors';
import { runEvaluation } from './evaluate';

const app = express();
app.use(cors());
app.use(express.json());

// Main Evaluation Trigger Endpoint
app.post('/api/evaluate', async (req, res) => {
  const { comparisonGroup, targetBranch, useNewMetrics } = req.body;

  try {
    console.log(`[EVALUATOR] Triggering evaluation run...`);
    // Run asynchronously or await. For Cloud Run with potentially long execution, a background task approach
    // or long-polling is needed. For simplicity, we'll await if it finishes within 30-60 mins timeout limits,
    // but the evaluation process might take multiple minutes.
    
    // Cloud Run HTTP requests typically timeout after 60 mins max, or 5 mins by default.
    // We will await it directly.
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

// Health check endpoint for Cloud Run
app.get('/api/status', (req, res) => {
  res.json({ status: 'healthy', service: 'gsr-evaluator' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 GSR Evaluator Service listening on port ${PORT}`);
});
