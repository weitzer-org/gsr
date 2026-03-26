import { Storage } from '@google-cloud/storage';
import * as fs from 'fs';
import * as path from 'path';

// Auto-load Service Account Key for Jetski environments if not set
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const saPath = path.join(__dirname, '../../jetski-sa-key.json');
  if (fs.existsSync(saPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = saPath;
  }
}

const storage = new Storage();
const gcpProjectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!gcpProjectId) {
  throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required.');
}
const bucketName = process.env.GCS_BUCKET || `gsr-eval-results-${gcpProjectId}`;

export async function main(args: string[]) {
  const action = args[0];
  
  if (action === 'list') {
    const bucket = storage.bucket(bucketName);
    const [files] = await bucket.getFiles({ prefix: 'eval-run_' });
    
    const fileList = files.map(f => ({
      name: f.name,
      updated: f.metadata.updated,
      size: f.metadata.size
    }));
    
    // Sort by updated descending
    fileList.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
    
    console.log(JSON.stringify(fileList));
  } else if (action === 'get') {
    const fileName = args[1];
    if (!fileName) {
      throw new Error('File name required for get action');
    }
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    const [contents] = await file.download();
    console.log(contents.toString('utf-8'));
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
