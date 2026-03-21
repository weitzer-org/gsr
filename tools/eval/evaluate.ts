import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

import { getSecret } from './secret-manager';
import { runReview, CombinedResult } from './api-client';
import { compareResultsWithLLM } from './llm-comparator';
import { uploadResultsToGCS, ensureBucketExists } from './gcs-storage';
import { buildRunMetadata } from './version-tracker';

async function main() {
  console.log('🚀 Starting GSR Evaluation Harness...');

  // Auto-load Service Account Key for Jetski environments
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const saPath = path.join(__dirname, '../../jetski-sa-key.json');
    if (fs.existsSync(saPath)) {
      console.log('🔑 Auto-loading jetski-sa-key.json for GCP authentication...');
      process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
    }
  }

  // Parse basic arguments / environment
  const configPath = process.argv.includes('--config') 
    ? process.argv[process.argv.indexOf('--config') + 1] 
    : path.join(__dirname, 'config.json');

  // 1. Load config
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found at ${configPath}. Exiting.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const localUrl = process.env.LOCAL_URL || 'http://localhost:8080';
  const prodUrl = config.production_url || process.env.PRODUCTION_URL || 'https://adk-backend-gsr-595305141203.us-central1.run.app';
  
  // NOTE: In production scenario, use dynamic project ID derivation or fallback 
  const gcpProjectId = process.env.GOOGLE_CLOUD_PROJECT || 'weitzer-org';
  const bucketName = process.env.GCS_BUCKET || `gsr-eval-results-${gcpProjectId}`;
  const patSecretName = process.env.GITHUB_PAT_SECRET || 'gsr-github-pat';
  const prs = config.sample_prs || [];

  if (!prs.length) {
    console.error(`❌ No PRs defined in config file. Exiting.`);
    process.exit(1);
  }

  // 2. Fetch Secrets
  console.log(`🔑 Fetching GitHub PAT from secret manager: ${patSecretName}...`);
  const githubPat = await getSecret(patSecretName);

  const geminiSecretName = process.env.GEMINI_SECRET || 'gsr-gemini-api-key';
  if (!process.env.GEMINI_API_KEY) {
    console.log(`🔑 Fetching Gemini API Key from secret manager: ${geminiSecretName}...`);
    try {
      const gKey = await getSecret(geminiSecretName);
      process.env.GEMINI_API_KEY = gKey; // Export it globally for llm-comparator
    } catch (e: any) {
      console.warn(`⚠️ Failed to fetch Gemini API key: ${e.message}`);
    }
  }

  // 3. Ensure GCS bucket exists
  await ensureBucketExists(bucketName);

  // 4. Initialize Metadata
  const runPayload: any = {
    ...buildRunMetadata(prodUrl),
    prs_tested: prs,
    results: []
  };

  // 4.5 Start Local Server
  console.log('🚀 Starting local backend server...');
  const { spawn } = require('child_process');
  
  // Start the backend server directly overriding the port just in case
  const serverProcess = spawn('npm', ['run', 'dev'], {
    cwd: path.resolve(__dirname, '../../adk/backend'),
    env: { ...process.env, PORT: '8080' },
    stdio: 'ignore' // Do not clutter evaluation output with server logs
  });

  process.on('exit', () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  process.on('SIGINT', () => {
    process.exit();
  });

  // Give it a moment to boot up
  await new Promise(resolve => setTimeout(resolve, 8000));
  console.log('✅ Local backend assumed ready.');

  // 5. Evaluate each PR
  for (const prUrl of prs) {
    console.log(`\n================================`);
    console.log(`🔍 Evaluating PR: ${prUrl}`);
    console.log(`================================`);

    console.log(`[Production] Sending review request to: ${prodUrl}`);
    let prodResult: CombinedResult;
    try {
      prodResult = await runReview(prodUrl, prUrl, githubPat);
      console.log(`✅ [Production] Retrieved ${prodResult.findings.length} findings.`);
    } catch (e: any) {
      console.error(`❌ [Production] Failed: ${e.message}`);
      prodResult = { findings: [], metrics: { calls:0, inputTokens:0, outputTokens:0 }, error: e.message };
    }

    console.log(`[Local] Sending review request to: ${localUrl}`);
    let localResult: CombinedResult;
    try {
      localResult = await runReview(localUrl, prUrl, githubPat);
      console.log(`✅ [Local] Retrieved ${localResult.findings.length} findings.`);
    } catch (e: any) {
      console.error(`❌ [Local] Failed: ${e.message}`);
      localResult = { findings: [], metrics: { calls:0, inputTokens:0, outputTokens:0 }, error: e.message };
    }

    // 6. Compare results with LLM if both succeeded roughly
    let llmEvaluation = 'Skipped due to API errors.';
    if (!prodResult.error && !localResult.error) {
       try {
         // Temporarily mock LLM comparison if GEMINI_API_KEY is not set since GenAI SDK throws error
         if (process.env.GEMINI_API_KEY) {
           llmEvaluation = await compareResultsWithLLM(prUrl, localResult.findings, prodResult.findings);
         } else {
           console.warn('⚠️ GEMINI_API_KEY is not set. Skipping LLM comparison step.');
           llmEvaluation = 'Skipped due to missing GEMINI_API_KEY.';
         }
       } catch (e: any) {
         console.error(`❌ [LLM] Evaluation failed: ${e.message}`);
         llmEvaluation = `Error: ${e.message}`;
       }
    }

    runPayload.results.push({
      prUrl,
      local: localResult,
      production: prodResult,
      llm_comparison_report: llmEvaluation
    });
  }

  // 7. Archive data
  const dateStr = runPayload.run_date.replace(/[:.]/g, '-');
  const uploadFileName = `eval-run_${dateStr}.json`;

  await uploadResultsToGCS(bucketName, uploadFileName, runPayload);

  // 4.5 Cleanup server process
  if (serverProcess) {
    console.log('🛑 Shutting down local backend server.');
    serverProcess.kill('SIGTERM');
  }

  console.log(`\n🎉 Evaluation Harness complete! Output archived.`);
}

main().catch(err => {
  console.error('\n💥 Unhandled error in evaluation harness:', err);
  process.exit(1);
});
