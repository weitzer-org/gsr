const { downloadFile } = require('./s3-debug-client');

async function checkPRs(file) {
  const contents = await downloadFile(file);
  const data = JSON.parse(contents);
  console.log(`\n\n=== Evals from ${file} ===\n`);

  const relevantPrs = [
    'https://github.com/weitzer-org/gemini-cli-fork/pull/3',
    'https://github.com/weitzer-org/gemini-cli-fork/pull/4',
    'https://github.com/weitzer-org/gemini-cli-fork/pull/5'
  ];

  data.results.forEach((r, i) => {
    if (relevantPrs.includes(r.prUrl)) {
      console.log(`PR: ${r.prUrl}`);
      console.log(`Target A (Local) Findings Count: ${r.targetA?.findings?.length}`);
      console.log(`Target B Findings Count: ${r.targetB?.findings?.length}`);
      console.log(`LLM Evaluation:\n${r.llm_comparison_report}\n`);
      console.log('--------------------------------------------------\n');
    }
  });
}

checkPRs('eval-run_2026-03-23T19-52-52-883Z.json')
  .catch(console.error);
