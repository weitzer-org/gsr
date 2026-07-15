const { downloadFile } = require('./s3-debug-client');

async function get(file) {
  const contents = await downloadFile(file);
  const data = JSON.parse(contents);
  console.log(`\n\n=== ${file} ===\n`);
  console.log(data.aggregate_report);
}

get('eval-run_2026-03-23T19-48-52-492Z.json')
  .then(() => get('eval-run_2026-03-23T19-52-52-883Z.json'))
  .catch(console.error);
