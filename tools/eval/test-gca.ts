import 'dotenv/config';
import { fetchBotComments } from './github-comments';

async function run() {
  const pat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error('GITHUB_PAT (or GITHUB_TOKEN) environment variable is required.');
  }

  const prs = [3, 4, 8]; 
  const targetRepo = process.env.GITHUB_TARGET_REPO || 'weitzer-org/gemini-cli-fork';
  for (const pr of prs) {
    const url = `https://github.com/${targetRepo}/pull/${pr}`;
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
