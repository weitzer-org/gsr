const { listFiles } = require('./tools/eval/s3-debug-client');

async function main() {
  try {
    const files = await listFiles();
    console.log('Files:');
    files.forEach(file => {
      console.log(file.name);
    });
  } catch (err) {
    console.error('ERROR:', err);
  }
}
main();
