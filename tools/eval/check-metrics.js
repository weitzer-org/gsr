const { Storage } = require('@google-cloud/storage');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../../jetski-sa-key.json');
const storage = new Storage({ projectId: 'weitzer-org' });

async function getStats(fileList) {
  for (const label of Object.keys(fileList)) {
    const file = fileList[label];
    const [contents] = await storage.bucket('gsr-eval-results-weitzer-org').file(file).download();
    const data = JSON.parse(contents);
    console.log(`\n\n=== ${label} (${file}) ===`);
    console.log(JSON.stringify(data.aggregate_metrics, null, 2));
  }
}

const files = {
  'Test 1 (Caching Disabled, vs Branch)': 'eval-run_2026-03-23T19-36-26-636Z.json',
  'Test 2 (Caching Disabled, vs Prod)': 'eval-run_2026-03-23T19-40-47-674Z.json',
  'Test 3 (Caching Enabled, vs Branch)': 'eval-run_2026-03-23T19-48-52-492Z.json',
  'Test 4 (Caching Enabled, vs Prod)': 'eval-run_2026-03-23T19-52-52-883Z.json',
};

getStats(files).catch(console.error);
