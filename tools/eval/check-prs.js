const { downloadFile } = require('./s3-debug-client');

async function checkPRs(file) {
  const contents = await downloadFile(file);
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
