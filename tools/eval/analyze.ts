import { listFiles, downloadFile } from './storage';

const bucketName = process.env.S3_BUCKET || 'gsr-eval-results';

async function main() {
  const fileList = await listFiles(bucketName, 'eval-run_');

  fileList.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());

  // The first 4 files
  const top4 = fileList.slice(0, 4);

  const testMap: Record<number, string> = {
    0: "Test 4 (Local Enabled vs Production)",
    1: "Test 3 (Local Enabled vs Branch)",
    2: "Test 2 (Local Disabled vs Production)",
    3: "Test 1 (Local Disabled vs Branch)"
  };

  for (let i = 0; i < 4; i++) {
    const f = top4[i];
    console.log(`\n=================== ${testMap[i]} ===================`);
    console.log(`File: ${f.name} (${f.updated})`);

    const contents = await downloadFile(bucketName, f.name);
    const data = JSON.parse(contents);

    console.log(`\n### Comparison Group: ${data.comparisonGroup}`);
    console.log(`### Vertex/Context Caching: ${data.useVertexAi}`);

    let localTotal = 0;
    let remoteTotal = 0;

    console.log(`\n--- PR Breakdown ---`);
    if (data.results) {
      for (const pr of data.results) {
        if (!pr.prUrl) continue;
        console.log(`- PR: ${pr.prUrl}`);
        const localCount = pr.targetA?.findings?.length || 0;
        const remoteCount = pr.targetB?.findings?.length || 0;
        localTotal += localCount;
        remoteTotal += remoteCount;
        console.log(`   Local Findings: ${localCount} | Remote Findings: ${remoteCount}`);
        if (pr.llm_comparison_report) {
            console.log(`   Eval Score (0-10 based on summary?): ${pr.llm_comparison_report.split('\n')[0].substring(0, 100)}...`);
        } else if (pr.targetA?.error || pr.targetB?.error) {
            console.log(`   Error Local: ${pr.targetA?.error} | Error Remote: ${pr.targetB?.error}`);
        }
      }
    }

    console.log(`\n--- Aggregate Summary ---`);
    console.log(`Totals -> Local: ${localTotal} | Remote: ${remoteTotal}`);
    console.log(data.aggregate_evaluation_report || "No Aggregate Summary Available.");
  }
}

main().catch(console.error);
