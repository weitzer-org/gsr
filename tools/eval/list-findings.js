const { Storage } = require('@google-cloud/storage');

const storage = new Storage({ keyFilename: '../../jetski-sa-key.json' });
const bucketName = 'gsr-eval-results-weitzer-org';

async function fetchFindings() {
  try {
    const [files] = await storage.bucket(bucketName).getFiles();
    files.sort((a, b) => new Date(a.metadata.updated).getTime() - new Date(b.metadata.updated).getTime());
    const file = files[files.length - 1]; // latest
    
    const [contents] = await file.download();
    const data = JSON.parse(contents.toString());
    
    console.log(`Analyzing: ${file.name}`);
    for (let i = 0; i < 2; i++) {
      const res = data.results[i];
      console.log(`\n================================`);
      console.log(`PR: ${res.prUrl}`);
      console.log(`Target A (${data.targetA_label}) Findings (${res.targetA?.findings?.length || 0}):`);
      (res.targetA?.findings || []).forEach(f => console.log(`  - [${f.severity}] ${f.file}:${f.line || '?'} | ${f.summary}`));
      
      console.log(`Target B (${data.targetB_label}) Findings (${res.targetB?.findings?.length || 0}):`);
      (res.targetB?.findings || []).forEach(f => console.log(`  - [${f.severity}] ${f.file}:${f.line || '?'} | ${f.summary}`));
      
      console.log(`\nLLM Comparison Report:\n${res.llm_comparison_report?.substring(0, 500)}...`);
    }
  } catch (err) {
    console.error('ERROR:', err);
  }
}
fetchFindings();
