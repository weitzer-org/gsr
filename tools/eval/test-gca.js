require('dotenv').config();
const { execSync } = require('child_process');
let pat = '';
try {
  const secretName = process.env.GITHUB_PAT_SECRET || 'gsr-github-pat';
  pat = execSync(`gcloud secrets versions access latest --secret=${secretName}`).toString().trim();
} catch (err) {
  console.error('Failed to retrieve GitHub PAT from gcloud secret manager. Exiting.');
  process.exit(1);
}
const { fetchBotComments } = require('./github-comments');

async function run() {
  const prs = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  let totalFindings = 0;
  let hasSuggestionBlock = 0;
  let hasCodeBlock = 0;

  for (const pr of prs) {
    const targetRepo = process.env.GITHUB_TARGET_REPO || 'weitzer-org/gemini-cli-fork';
    const url = `https://github.com/${targetRepo}/pull/${pr}`;
    try {
      const { gcaFindings } = await fetchBotComments(url, pat);
      console.log(`\n=== PR ${pr} (Findings: ${gcaFindings.length}) ===`);
      gcaFindings.forEach((f, i) => {
        totalFindings++;
        const body = f.issueDescription || '';
        const hasSuggestion = body.includes('```suggestion');
        const hasCode = /```(?!suggestion)/.test(body);

        if (hasSuggestion) hasSuggestionBlock++;
        if (hasCode) hasCodeBlock++;
        
        console.log(`[GCA ${i+1}] Has \`\`\`suggestion: ${hasSuggestion} | Has other \`\`\`code: ${hasCode}`);
      });
    } catch (e) {
      console.error(`Error fetching PR ${pr}`, e.message);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Total GCA Findings across 10 PRs: ${totalFindings}`);
  if (totalFindings === 0) {
    console.log("No findings to calculate percentages.");
    return;
  }
  console.log(`Findings with \`\`\`suggestion block: ${hasSuggestionBlock} (${Math.round(hasSuggestionBlock/totalFindings*100)}%)`);
  console.log(`Findings with other \`\`\`code blocks: ${hasCodeBlock} (${Math.round(hasCodeBlock/totalFindings*100)}%)`);
  console.log(`Findings with NO code snippets at all: ${totalFindings - hasSuggestionBlock - hasCodeBlock} (${Math.round((totalFindings - hasSuggestionBlock - hasCodeBlock)/totalFindings*100)}%)`);
}
run();
