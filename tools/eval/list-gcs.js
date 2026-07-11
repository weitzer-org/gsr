const { listFiles, downloadFile } = require('./s3-debug-client');

async function fetchAll() {
  try {
    const files = await listFiles();
    files.sort((a, b) => new Date(a.updated || 0).getTime() - new Date(b.updated || 0).getTime());
    const file = files[files.length - 1]; // latest

    const contents = await downloadFile(file.name);
    const data = JSON.parse(contents);

    console.log(JSON.stringify(data.aggregate_metrics, null, 2));

  } catch (err) {
    console.error('ERROR:', err);
  }
}
fetchAll();
