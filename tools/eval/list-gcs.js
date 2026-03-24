const { Storage } = require('@google-cloud/storage');

const storage = new Storage({ keyFilename: '../../jetski-sa-key.json' });
const bucketName = 'gsr-eval-results-weitzer-org';

async function fetchAll() {
  try {
    const [files] = await storage.bucket(bucketName).getFiles();
    files.sort((a, b) => new Date(a.metadata.updated).getTime() - new Date(b.metadata.updated).getTime());
    const file = files[files.length - 1]; // latest
    
    const [contents] = await file.download();
    const data = JSON.parse(contents.toString());
    
    console.log(JSON.stringify(data.aggregate_metrics, null, 2));
    
  } catch (err) {
    console.error('ERROR:', err);
  }
}
fetchAll();
