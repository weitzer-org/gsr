const { spawn } = require('child_process');
const http = require('http');

const runServer = (env) => {
  return new Promise((resolve) => {
    const serverProcess = spawn('node', ['dist/src/index.js'], {
      cwd: './adk/backend',
      env: { ...process.env, ...env }
    });

    serverProcess.stdout.on('data', (data) => {
      const str = data.toString();
      console.log(`[Backend Log]: ${str.trim()}`);
      if (str.includes('Server running on port 8080') || str.includes('listening')) {
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Backend Error]: ${data.toString().trim()}`);
      if (data.toString().includes('address already in use')) {
        resolve(serverProcess);
      }
    });
  });
};

const sendRequest = (path, method, body = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 8080,
      path: path,
      method: method,
      headers: {}
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      let output = '';
      res.on('data', (chunk) => {
        output += chunk;
      });
      res.on('end', () => {
        resolve(output);
      });
    });

    req.on('error', (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
};

async function main() {
  console.log('--- Starting Backend Server ---');
  // Need to provide PAT, correct API key, and GCP credentials
  const env = { 
    GOOGLE_APPLICATION_CREDENTIALS: '/Users/benweitzer/projects/GSR/jetski-sa-key.json',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AIzaSyANsnSnyH8_vVtRJuc9-7fitK_JlOENmCI',
    GCS_REVIEW_BUCKET: 'gsr-review-results-weitzer-org'
  };

  try {
    const path = require('path');
    const storageModule = require(path.join(__dirname, 'adk/backend/node_modules/@google-cloud/storage'));
    const storage = new storageModule.Storage({ keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS });
    const bucket = storage.bucket(env.GCS_REVIEW_BUCKET);
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log(`Bucket ${env.GCS_REVIEW_BUCKET} does not exist, creating it...`);
      await storage.createBucket(env.GCS_REVIEW_BUCKET, { location: 'US' });
      console.log('Bucket created!');
    } else {
      console.log(`Bucket ${env.GCS_REVIEW_BUCKET} already exists.`);
    }
  } catch(e) { 
      console.error('Bucket creation check failed', e.message); 
  }
  
  let server = await runServer(env);
  
  try {
    console.log('\n--- Triggering Review API ---');
    const prUrl = 'https://github.com/benw307/logo-maker-weitzer/pull/69';
    const pat = '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'; // From dev_test_config.json
    
    const body = JSON.stringify({ url: prUrl, pat: pat });
    const output = await sendRequest('/api/review', 'POST', body);
    
    // Check if output has 'done' line
    if (!output.includes('"type":"done"')) {
       console.log("Review result missing done type:", output.slice(0, 500) + '...');
    } else {
       console.log("Review stream completed successfully!");
    }
    
    // Give GCS upload a second to complete asynchronously
    console.log("\nWaiting 2 seconds for GCS async upload...");
    await new Promise(r => setTimeout(r, 2000));
    
    console.log('\n--- Fetching History List ---');
    const historyOutput = await sendRequest('/api/review/history', 'GET');
    
    const historyList = JSON.parse(historyOutput);
    console.log(`Found ${historyList.length} reviews in history bucket.`);
    if (historyList.length > 0) {
       console.log("Latest review document:", historyList[0]);
    } else {
       console.log("No history records found in GCS.");
    }
    
  } catch (e) {
    console.error('Request failed:', e);
  } finally {
    if (server) {
      server.kill();
      // Ensure it shuts down completely
      process.kill(server.pid, 'SIGKILL');
    }
    process.exit(0);
  }
}

main();
