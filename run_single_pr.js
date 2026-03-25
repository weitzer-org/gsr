const { spawn } = require('child_process');
const http = require('http');

const runServer = (env) => {
  return new Promise((resolve) => {
    const serverProcess = spawn('npm', ['run', 'start'], {
      cwd: './adk/backend',
      env: { ...process.env, ...env }
    });

    serverProcess.stdout.on('data', (data) => {
      const str = data.toString();
      if (str.includes('listening')) {
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      // ignore
    });
  });
};

const sendRequest = (prUrl) => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      url: prUrl,
      pat: process.env.GITHUB_PAT || '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'
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/review',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      },
      (res) => {
        let output = '';
        res.on('data', (chunk) => {
          output += chunk;
        });
        res.on('end', () => {
          const lines = output.trim().split('\n');
          let finalFindings = [];
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'done') {
                finalFindings = parsed.findings || [];
              }
            } catch (e) {
            }
          }
          resolve(finalFindings);
        });
      }
    );

    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
};

async function main() {
  console.log('--- Starting Code Review ---');
  let server = await runServer({ USE_CONTEXT_CACHING: 'true', USE_VERTEX_AI: 'true', GEMINI_API_KEY: 'AIzaSyANsnSnyH8_vVtRJuc9-7fitK_JlOENmCI' });
  try {
    const findings = await sendRequest('https://github.com/weitzer-org/gsr/pull/24');
    
    console.log(`\nFound ${findings.length} issues in PR 24:\n`);
    findings.forEach((finding, index) => {
      console.log(`[Finding ${index + 1} - ${finding.severity}] File: ${finding.fileName}:${finding.lineNumber}`);
      console.log(`Issue: ${finding.issueDescription}`);
      console.log(`Suggestion: ${finding.suggestion}\n`);
    });
    
  } catch (e) {
    console.error('Request failed:', e);
  }
  server.kill();
  process.exit(0);
}

main();
