// A local stand-in for object storage, used by every live eval script so that a run can never write
// into whatever bucket the operator's shell happens to be configured for (this session's own
// environment points S3_* at ANOTHER project's real bucket). The backend and the judge step both
// persist per-call usage records and review history through the S3 client; pointing that client at
// this sink means those writes land on local disk (usage/ keys only) or nowhere.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

export interface NullS3 {
  endpoint: string;
  saved: () => number;
  close: () => Promise<void>;
}

// Every credential / destination variable that could point a child process at a real store or
// service. Removed from child environments, never merely overridden by omission.
export const STORAGE_SCRUB_PATTERNS: readonly RegExp[] = [
  /^S3_/, /^AWS_/, /^R2_/, /^USAGE_INGEST_/, /^FEEDBACK_/, /^EVALUATOR_/, /^GOOGLE_APPLICATION_CREDENTIALS$/,
];

export function scrubStorageEnv(env: NodeJS.ProcessEnv): void {
  for (const k of Object.keys(env)) if (STORAGE_SCRUB_PATTERNS.some(p => p.test(k))) delete env[k];
}

// The S3 settings that point a process at the sink. `scope` namespaces the buckets so several
// processes (one per arm) can share one sink and still be told apart on disk.
export function sinkEnv(endpoint: string, scope: string): Record<string, string> {
  return {
    S3_ENDPOINT: endpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'eval-null-sink',
    S3_SECRET_ACCESS_KEY: 'eval-null-sink',
    S3_BUCKET: `eval-${scope}`,
    S3_REVIEW_BUCKET: `eval-${scope}-review`,
    S3_FEEDBACK_BUCKET: `eval-${scope}-feedback`,
  };
}

const XML = { 'Content-Type': 'application/xml' };

export function startNullS3(opts: { saveDir?: string } = {}): Promise<NullS3> {
  let saved = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://sink');
      const [bucket, ...rest] = url.pathname.replace(/^\/+/, '').split('/');
      const key = decodeURIComponent(rest.join('/'));
      if (req.method === 'PUT' && key) {
        if (opts.saveDir && key.startsWith('usage/') && !key.includes('..')) {
          const file = path.join(opts.saveDir, bucket.replace(/[^A-Za-z0-9._-]/g, '_'), key);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.concat(chunks));
          saved++;
        }
        res.writeHead(200, { ETag: '"null-sink"' });
        return res.end();
      }
      if (req.method === 'PUT' || (req.method === 'HEAD' && !key)) { res.writeHead(200); return res.end(); }
      if (req.method === 'GET' && url.searchParams.has('list-type')) {
        res.writeHead(200, XML);
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`);
      }
      res.writeHead(404, XML);
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>null sink stores nothing</Message></Error>');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        saved: () => saved,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}
