const { Storage } = require('@google-cloud/storage');
const storage = new Storage();
const bucketName = 'gsr-eval-results-weitzer-org';

async function listFiles() {
  try {
    const [files] = await storage.bucket(bucketName).getFiles();
    console.log('Files:');
    files.forEach(file => {
      console.log(file.name);
    });
  } catch (err) {
    console.error('ERROR:', err);
  }
}
listFiles();
