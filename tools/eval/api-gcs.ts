import { listFiles, downloadFile } from './storage';

export async function main(args: string[]) {
  const bucketName = process.env.S3_BUCKET || 'gsr-eval-results';
  const action = args[0];

  if (action === 'list') {
    const files = await listFiles(bucketName, 'eval-run_');
    files.sort((a, b) => new Date(b.updated || 0).getTime() - new Date(a.updated || 0).getTime());
    console.log(JSON.stringify(files));
  } else if (action === 'get') {
    const fileName = args[1];
    if (!fileName) {
      throw new Error('File name required for get action');
    }
    const contents = await downloadFile(bucketName, fileName);
    console.log(contents);
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
