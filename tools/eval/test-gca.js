const { execSync } = require('child_process');
const pat = execSync('gcloud secrets versions access latest --secret=gsr-github-pat').toString().trim();
const { fetchBotComments } = require('./github-comments');

async function run() {
  const prs = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  let totalFindings = 0;
  let hasSuggestionBlock = 0;
  let hasCodeBlock = 0;

  for (const pr of prs) {
    const url = `https://github.com/weitzer-org/gemini-cli-fork/pull/${pr}`;
    try {
      const { gcaFindings } = await fetchBotComments(url, pat);
      console.log(`\n=== PR ${pr} (Findings: ${gcaFindings.length}) ===`);
      gcaFindings.forEach((f, i) => {
        totalFindings++;
        const body = f.issueDescription || '';
        const hasSuggestion = body.includes('```suggestion');
        const hasCode = body.includes('```') && !hasSuggestion;

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
  console.log(`Findings with \`\`\`suggestion block: ${hasSuggestionBlock} (${Math.round(hasSuggestionBlock/totalFindings*100)}%)`);
  console.log(`Findings with other \`\`\`code blocks: ${hasCodeBlock} (${Math.round(hasCodeBlock/totalFindings*100)}%)`);
  console.log(`Findings with NO code snippets at all: ${totalFindings - hasSuggestionBlock - hasCodeBlock} (${Math.round((totalFindings - hasSuggestionBlock - hasCodeBlock)/totalFindings*100)}%)`);
}
run();
