import { fetchBotComments } from './github-comments';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

async function run() {
  const secretClient = new SecretManagerServiceClient();
  const [patVersion] = await secretClient.accessSecretVersion({ name: 'projects/951478177587/secrets/gsr-github-pat/versions/latest' });
  const pat = patVersion.payload?.data?.toString() || '';

  const prs = [3, 4, 8]; 
  for (const pr of prs) {
    const url = `https://github.com/weitzer-org/gemini-cli-fork/pull/${pr}`;
    console.log(`\n=== PR ${pr} ===`);
    try {
      const { gcaFindings } = await fetchBotComments(url, pat);
      gcaFindings.forEach((f: any, i: number) => {
        console.log(`\n[GCA Finding ${i+1}] File: ${f.fileName} Line: ${f.lineNumber}`);
        console.log(`BODY:\n${f.issueDescription}\n`);
      });
    } catch (e: any) {
      console.log('Error fetching', e.message);
    }
  }
}
run();
