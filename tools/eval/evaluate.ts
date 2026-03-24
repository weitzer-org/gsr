import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

import { getSecret } from './secret-manager';
import { runReview, CombinedResult } from './api-client';
import { compareResultsWithLLM, generateAggregateReport } from './llm-comparator';
import { uploadResultsToGCS, ensureBucketExists } from './gcs-storage';
import { buildRunMetadata } from './version-tracker';

import { CloudBuildClient } from '@google-cloud/cloudbuild';
import { fetchBotComments } from './github-comments';
import { validateFindingsAgainstDiff } from './validation';
import { compareResultsWithLLMV2, generateAggregateReportV2, V2ComparisonMetrics } from './llm-comparator-v2';
import { GitHubClient } from '../../adk/backend/src/github';

async function deployStagingBranch(branch: string, githubPat: string): Promise<string> {
    console.log(`\n☁️  Triggering Cloud Build via Node SDK for branch '${branch}'...`);
    const client = new CloudBuildClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'quacktastic-waffle';
    const triggerId = 'gsr-eval-staging'; // Manual Trigger ID defined in GCP
    
    try {
      const [operation] = await client.runBuildTrigger({
        name: `projects/${projectId}/locations/us-central1/triggers/gsr-eval-staging`,
        source: {
          branchName: branch,
          repoName: 'gsr',
          projectId
        }
      });
      
      console.log('☁️  Build trigger started. Waiting for pipeline to finish (this may take a few minutes)...');
      const [buildResult] = await operation.promise();
      
      if (buildResult.status !== 'SUCCESS' && buildResult.status !== 3) {
         throw new Error(`Cloud Build failed with status: ${buildResult.status}`);
      }
      
      return new Promise((resolve, reject) => {
        console.log('☁️  Build successful! Fetching staging URL...');
        const { exec } = require('child_process');
        exec(`export PATH="$HOME/google-cloud-sdk/bin:$PATH" && gcloud run services describe gsr-code-review-staging --region us-central1 --format="value(status.url)"`, (err: any, stdout: string) => {
            if (err) return reject(err);
            resolve(stdout.trim());
        });
      });
    } catch (err: any) {
      throw new Error(`Failed to deploy staging branch: ${err.message}`);
    }
}

export interface EvalOptions {
  compGroup?: string;
  targetBranch?: string;
  useNewMetrics?: boolean;
}

export async function runEvaluation(options: EvalOptions = {}) {
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
    : fs.existsSync(path.join(__dirname, 'config.json')) ? path.join(__dirname, 'config.json') : path.resolve(process.cwd(), 'config.json');
  const useNewMetrics = options.useNewMetrics ?? process.argv.includes('--use-new-metrics');

  // 1. Load config
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found at ${configPath}. Exiting.`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const compGroup = options.compGroup || process.env.EVAL_COMPARISON_GROUP || 'local_vs_production';
  const targetBranch = options.targetBranch || process.env.EVAL_TARGET_BRANCH || '';

  const localUrl = process.env.LOCAL_URL || 'http://localhost:8080';
  const prodUrl = config.production_url || process.env.PRODUCTION_URL || 'https://adk-backend-gsr-595305141203.us-central1.run.app';
  
  let targetAConfig = { label: 'Local', url: localUrl, isLocal: true, isBranch: false };
  let targetBConfig = { label: 'Production', url: prodUrl, isLocal: false, isBranch: false };

  if (compGroup === 'local_vs_branch') {
     targetBConfig = { label: `Branch '${targetBranch}'`, url: '', isLocal: false, isBranch: true };
  } else if (compGroup === 'branch_vs_production') {
     targetAConfig = { label: `Branch '${targetBranch}'`, url: '', isLocal: false, isBranch: true };
  }
  
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

  // 3.5. Branch deployments if required
  if (targetAConfig.isBranch) targetAConfig.url = await deployStagingBranch(targetBranch, githubPat);
  if (targetBConfig.isBranch) targetBConfig.url = await deployStagingBranch(targetBranch, githubPat);

  // 4. Initialize Metadata
  const isCloudRun = !!process.env.K_SERVICE;
  const runPayload: any = {
    ...buildRunMetadata(prodUrl),
    execution_environment: isCloudRun ? `Server: gsr-evaluator Cloud Run` : `Server: Localhost CLI`,
    prs_tested: prs,
    targetA_label: targetAConfig.label,
    targetB_label: targetBConfig.label,
    results: []
  };

  // 4.5 Start Local Server
  let serverProcess: any = null;
  if (targetAConfig.isLocal || targetBConfig.isLocal) {
    console.log('🚀 Starting local backend server...');
    const { spawn } = require('child_process');
    
    // Start the backend server directly overriding the port just in case
    serverProcess = spawn('npm', ['run', 'start'], {
      cwd: path.resolve(__dirname, '../../adk/backend'),
      env: { ...process.env, PORT: '8080' },
      stdio: 'inherit' // Do not clutter evaluation output with server logs
    });

    process.on('exit', () => {
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGTERM');
      }
    });

    process.on('SIGINT', () => {
      process.exit();
    });

    // Wait for backend to be ready via health check polling
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(localUrl);
        if (res.ok) break;
        throw new Error("Not ok");
      } catch (e) {
        if (i === 19) console.warn("Local backend took too long to start, moving on...");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    console.log('✅ Local backend assumed ready.');
  }

  // 5. Evaluate all PRs concurrently
  const evalPromises = prs.map(async (prUrl: string) => {
    console.log(`\n================================`);
    console.log(`🔍 Evaluating PR: ${prUrl}`);
    console.log(`================================`);

    console.log(`[${targetAConfig.label} & ${targetBConfig.label}] Sending review requests simultaneously...`);
    
    const targetAPromise = runReview(targetAConfig.url, prUrl, githubPat)
      .then(res => {
        console.log(`✅ [${targetAConfig.label}] Retrieved ${res.findings.length} findings.`);
        return res;
      })
      .catch(e => {
        console.error(`❌ [${targetAConfig.label}] Failed: ${e.message}`);
        return { findings: [], metrics: { calls:0, inputTokens:0, outputTokens:0 }, error: e.message };
      });

    const targetBPromise = runReview(targetBConfig.url, prUrl, githubPat)
      .then(res => {
        console.log(`✅ [${targetBConfig.label}] Retrieved ${res.findings.length} findings.`);
        return res;
      })
      .catch(e => {
        console.error(`❌ [${targetBConfig.label}] Failed: ${e.message}`);
        return { findings: [], metrics: { calls:0, inputTokens:0, outputTokens:0 }, error: e.message };
      });

    const [targetAResult, targetBResult] = await Promise.all([targetAPromise, targetBPromise]);

    // 6. Compare results with LLM if both succeeded roughly
    let llmEvaluation = 'Skipped due to API errors.';
    let v2Metrics: V2ComparisonMetrics | undefined = undefined;

    if (!targetAResult.error && !targetBResult.error) {
       try {
         if (process.env.GEMINI_API_KEY) {
           if (useNewMetrics) {
             console.log(`[V2] Fetching PR Diff for validation...`);
             const githubClient = new GitHubClient(githubPat);
             const prDiff = await githubClient.getPRDiff(prUrl);

             console.log(`[V2] Fetching third-party bot comments...`);
             const { gcaFindings, codeRabbitFindings } = await fetchBotComments(prUrl, githubPat);

             console.log(`[V2] Validating findings against PR Diff...`);
             const aValid = validateFindingsAgainstDiff(targetAResult.findings, prDiff);
             const bValid = validateFindingsAgainstDiff(targetBResult.findings, prDiff);
             const gcaValid = validateFindingsAgainstDiff(gcaFindings, prDiff);
             const codeRabbitValid = validateFindingsAgainstDiff(codeRabbitFindings, prDiff);
             
             // Run the V2 LLM comparator on the valid findings
             const v2Res = await compareResultsWithLLMV2(prUrl, aValid.validFindings, bValid.validFindings, gcaValid.validFindings, codeRabbitValid.validFindings, targetAConfig.label, targetBConfig.label);
             llmEvaluation = v2Res.report;
             v2Metrics = v2Res.metrics;
             
             // Inject the extra stats into the payload
             (targetAResult as any).v2Validation = { valid: aValid.validFindings.length, hallucinated: aValid.hallucinatedFindings.length };
             (targetBResult as any).v2Validation = { valid: bValid.validFindings.length, hallucinated: bValid.hallucinatedFindings.length };
             (targetAResult as any).gcaValidation = { valid: gcaValid.validFindings.length, hallucinated: gcaValid.hallucinatedFindings.length };
             (targetAResult as any).codeRabbitValidation = { valid: codeRabbitValid.validFindings.length, hallucinated: codeRabbitValid.hallucinatedFindings.length };
           } else {
             llmEvaluation = await compareResultsWithLLM(prUrl, targetAResult.findings, targetBResult.findings, targetAConfig.label, targetBConfig.label);
           }
         } else {
           console.warn('⚠️ GEMINI_API_KEY is not set. Skipping LLM comparison step.');
           llmEvaluation = 'Skipped due to missing GEMINI_API_KEY.';
         }
       } catch (e: any) {
         console.error(`❌ [LLM] Evaluation failed: ${e.message}`);
         llmEvaluation = `Error: ${e.message}`;
       }
    }

    let gcaFindingsCount = 0;
    let codeRabbitFindingsCount = 0;
    if (useNewMetrics && !targetAResult.error) {
        gcaFindingsCount = (targetAResult as any).gcaValidation?.valid || 0;
        codeRabbitFindingsCount = (targetAResult as any).codeRabbitValidation?.valid || 0;
    }

    return {
      prUrl,
      targetA: targetAResult,
      targetB: targetBResult,
      llm_comparison_report: llmEvaluation,
      v2Metrics,
      gcaFindingsCount,
      codeRabbitFindingsCount
    };
  });

  runPayload.results = await Promise.all(evalPromises);

  // 6.5 Generate aggregate evaluation report
  const validReports = runPayload.results
    .map((r: any) => {
      let combined = "";
      if (r.llm_comparison_report && !r.llm_comparison_report.startsWith('Skipped due to') && !r.llm_comparison_report.startsWith('Error:')) {
        combined += `--- **${targetAConfig.label} vs ${targetBConfig.label} Comparison** ---\n${r.llm_comparison_report}`;
      }
      if (r.targetA?.evaluation) {
        combined += `\n\n--- **Subagent vs Basic Agent Comparison (${targetAConfig.label})** ---\n${r.targetA.evaluation}`;
      }
      return combined.trim() || null;
    })
    .filter((r: any) => r !== null);

  const aggregateMetrics: any = {
    targetA: { inputTokens: 0, outputTokens: 0, calls: 0, findingsCount: 0 },
    targetB: { inputTokens: 0, outputTokens: 0, calls: 0, findingsCount: 0 },
    gca: { findingsCount: 0 },
    codeRabbit: { findingsCount: 0 }
  };
  
  for (const r of runPayload.results) {
    if (r.targetA?.metrics) {
       aggregateMetrics.targetA.inputTokens += r.targetA.metrics.inputTokens || 0;
       aggregateMetrics.targetA.outputTokens += r.targetA.metrics.outputTokens || 0;
       aggregateMetrics.targetA.calls += r.targetA.metrics.calls || 0;
       aggregateMetrics.targetA.findingsCount += r.targetA.findings?.length || 0;
    }
    if (r.targetB?.metrics) {
       aggregateMetrics.targetB.inputTokens += r.targetB.metrics.inputTokens || 0;
       aggregateMetrics.targetB.outputTokens += r.targetB.metrics.outputTokens || 0;
       aggregateMetrics.targetB.calls += r.targetB.metrics.calls || 0;
       aggregateMetrics.targetB.findingsCount += r.targetB.findings?.length || 0;
    }
    if (useNewMetrics) {
       aggregateMetrics.gca.findingsCount += r.gcaFindingsCount || 0;
       aggregateMetrics.codeRabbit.findingsCount += r.codeRabbitFindingsCount || 0;
    }
  }
  
  if (useNewMetrics) {
    const emptyTarget = { actionability: 0, falsePositives: 0, uniqueFindings: 0 };
    const llmAggregatedMetrics: any = {
        targetA: { ...emptyTarget },
        targetB: { ...emptyTarget },
        gca: { ...emptyTarget },
        codeRabbit: { ...emptyTarget },
        overlapMatrix: {
          targetA_targetB: 0,
          targetA_gca: 0,
          targetA_codeRabbit: 0,
          targetB_gca: 0,
          targetB_codeRabbit: 0,
          gca_codeRabbit: 0
        }
    };
    let count = 0;
    for (const r of runPayload.results) {
        if (r.v2Metrics) {
            count++;
            for (const key of ['targetA', 'targetB', 'gca', 'codeRabbit']) {
              llmAggregatedMetrics[key].actionability += r.v2Metrics[key]?.actionability || 0;
              llmAggregatedMetrics[key].falsePositives += r.v2Metrics[key]?.falsePositives || 0;
              llmAggregatedMetrics[key].uniqueFindings += r.v2Metrics[key]?.uniqueFindings || 0;
            }
            if (r.v2Metrics.overlapMatrix) {
              for (const matrixKey of ['targetA_targetB', 'targetA_gca', 'targetA_codeRabbit', 'targetB_gca', 'targetB_codeRabbit', 'gca_codeRabbit']) {
                llmAggregatedMetrics.overlapMatrix[matrixKey] += r.v2Metrics.overlapMatrix[matrixKey] || 0;
              }
            }
            
            // Add deterministic diff hallucinations
            llmAggregatedMetrics.targetA.falsePositives += (r.targetA?.v2Validation?.hallucinated || 0);
            llmAggregatedMetrics.targetB.falsePositives += (r.targetB?.v2Validation?.hallucinated || 0);
            llmAggregatedMetrics.gca.falsePositives += (r.targetA?.gcaValidation?.hallucinated || 0);
            llmAggregatedMetrics.codeRabbit.falsePositives += (r.targetA?.codeRabbitValidation?.hallucinated || 0);
        }
    }
    if (count > 0) {
        for (const key of ['targetA', 'targetB', 'gca', 'codeRabbit']) {
            llmAggregatedMetrics[key].actionability /= count;
        }
    }
    runPayload.llm_aggregated_metrics = llmAggregatedMetrics;
  }

  runPayload.aggregate_metrics = aggregateMetrics;

  if (validReports.length > 0 && process.env.GEMINI_API_KEY) {
    try {
      if (useNewMetrics) {
         const reportOutput = await generateAggregateReportV2(validReports, aggregateMetrics, targetAConfig.label, targetBConfig.label, runPayload.llm_aggregated_metrics);
         runPayload.aggregate_report = `> **Execution Environment:** ${runPayload.execution_environment}\n\n${reportOutput}`;
      } else {
         const reportOutput = await generateAggregateReport(validReports, aggregateMetrics, targetAConfig.label, targetBConfig.label);
         runPayload.aggregate_report = `> **Execution Environment:** ${runPayload.execution_environment}\n\n${reportOutput}`;
      }
    } catch (e: any) {
      console.error(`❌ [LLM Aggregate] Failed: ${e.message}`);
      runPayload.aggregate_report = `Error: ${e.message}`;
    }
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

  console.log(`\n🎉 Evaluation Harness complete! Output archived: ${uploadFileName}`);
  return { status: 'success', uploadFileName, metadata: runPayload };
}

if (require.main === module) {
  runEvaluation().catch(err => {
    console.error('\n💥 Unhandled error in evaluation harness:', err);
    if (process.exit) process.exit(1);
  });
}
