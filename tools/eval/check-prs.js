const { Storage } = require('@google-cloud/storage');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../../jetski-sa-key.json');
const storage = new Storage({ projectId: 'weitzer-org' });

async function checkPRs(file) {
  const [contents] = await storage.bucket('gsr-eval-results-weitzer-org').file(file).download();
  const data = JSON.parse(contents);
  console.log(`\n\n=== ${file} ===\n`);
  data.results.slice(0, 3).forEach((r, i) => { // Just look at first 3 PRs as a sample for verification
    console.log(`PR ${i+1}: ${r.prUrl}`);
    console.log(`Target A Findings: ${r.targetA?.findings?.length}`);
    console.log(`Target B Findings: ${r.targetB?.findings?.length}`);
    console.log(`LLM Evaluation snippet: ${r.llm_comparison_report.substring(0, 300)}...\n`);
  });
}

checkPRs('eval-run_2026-03-23T19-48-52-492Z.json')
  .then(() => checkPRs('eval-run_2026-03-23T19-52-52-883Z.json'))
  .catch(console.error);
