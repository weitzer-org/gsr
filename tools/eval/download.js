const { Storage } = require('@google-cloud/storage');
const path = require('path');

process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '../../jetski-sa-key.json');
const storage = new Storage({ projectId: 'weitzer-org' });

async function get(file) {
  const [contents] = await storage.bucket('gsr-eval-results-weitzer-org').file(file).download();
  const data = JSON.parse(contents);
  console.log(`\n\n=== ${file} ===\n`);
  console.log(data.aggregate_report);
}

get('eval-run_2026-03-23T19-48-52-492Z.json')
  .then(() => get('eval-run_2026-03-23T19-52-52-883Z.json'))
  .catch(console.error);
