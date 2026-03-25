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
      console.log('stdout:', str);
      if (str.includes('listening')) {
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });
  });
};

const sendRequest = () => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      url: 'https://github.com/expressjs/express/pull/5082',
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
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === 'done') {
                resolve(parsed.metrics);
                return;
              }
            } catch (e) {
              // Ignore partial or non-JSON lines
            }
          }
          reject('No metrics found in response');
        });
      }
    );

    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
};

async function main() {
  console.log('--- Test 1: Context Caching DISABLED, Vertex AI DISABLED ---');
  let server = await runServer({ USE_CONTEXT_CACHING: 'false', USE_VERTEX_AI: 'false', GEMINI_API_KEY: 'AIzaSyANsnSnyH8_vVtRJuc9-7fitK_JlOENmCI' });
  try {
    const metricsDisabled = await sendRequest();
    console.log('Metrics (Disabled):', metricsDisabled);
  } catch (e) {
    console.error('Request failed:', e);
  }
  server.kill();

  console.log('\n--- Test 2: Context Caching ENABLED, Vertex AI ENABLED ---');
  // Wait to ensure port is freed
  await new Promise(r => setTimeout(r, 2000));
  
  server = await runServer({ USE_CONTEXT_CACHING: 'true', USE_VERTEX_AI: 'true', GEMINI_API_KEY: 'AIzaSyANsnSnyH8_vVtRJuc9-7fitK_JlOENmCI' });
  try {
    const metricsEnabled = await sendRequest();
    console.log('Metrics (Enabled):', metricsEnabled);
  } catch (e) {
    console.error('Request failed:', e);
  }
  server.kill();
  process.exit(0);
}

main();
