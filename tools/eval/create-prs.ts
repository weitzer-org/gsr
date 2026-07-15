async function main() {
  const githubPat = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN;
  if (!githubPat) {
    throw new Error('GITHUB_PAT (or GITHUB_TOKEN) environment variable is required.');
  }
  
  const branches = [
    { head: 'evals/cli-input-loop-bug', title: 'fix: Why pressing Enter does nothing', body: 'Fixes CLI input blocking bug' },
    { head: 'evals/quota-config-leak', title: 'feat: User-Configurable Daily Quota Reset Times', body: 'Adds feature for quota configuration' },
    { head: 'evals/state-bloat-crash', title: 'perf: Fix application state memory bloat', body: 'Fix application state memory bloat' },
    { head: 'evals/auth-token-leak', title: 'fix: MCP HTTP OAuth Token Refresh Fails During Tool Calls', body: 'Auth Token Leak Fix' },
    { head: 'evals/spread-linter-dependency-break', title: 'chore: Disallow and suppress misused spread operator', body: 'Adds spread operator constraint' },
    { head: 'evals/legacy-spread-mutations', title: 'chore: Remove suppressed spread operator linter errors', body: 'Removes legacy suppression' },
    { head: 'evals/skill-invocation-coupling', title: 'feat: Tool use based skill invocation', body: 'Adds skill invocation features' },
    { head: 'evals/stub-evals-promise-swallow', title: 'test: Change the steering eval test to always pass', body: 'Mocks eval tests' },
    { head: 'evals/tasks-memory-leak', title: 'feat: SDD Phase 3 Tasks Integration', body: 'Adds task poller memory leak defect' },
    { head: 'evals/nightly-release-permissions', title: 'ci: Nightly Release Failed Fix', body: 'Fixes CI night failures' }
  ];

  const repo = 'weitzer-org/gemini-cli-fork';
  let urls = [];

  for (const b of branches) {
    console.log(`Creating PR for ${b.head}...`);
    const resp = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${githubPat}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: b.title,
        body: b.body,
        head: b.head,
        base: 'main'
      })
    });
    
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Failed to create PR for ${b.head}: ${resp.status}`, err);
    } else {
      const json = await resp.json();
      console.log(`Created PR: ${json.html_url}`);
      urls.push(json.html_url);
    }
  }

  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  config.sample_prs = urls;
  fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
  console.log("Updated config.json");
}

main().catch(console.error);
