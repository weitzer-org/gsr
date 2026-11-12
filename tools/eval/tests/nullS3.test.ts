import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { startNullS3, scrubStorageEnv, sinkEnv } from '../nullS3';
import { buildBackendEnv, loadArms } from '../arms';

const arms = loadArms(path.join(__dirname, '..', 'arms', 'model-upgrade.json'));

describe('null S3 sink', () => {
  it('accepts writes from the real AWS SDK, keeps usage/ objects per bucket on disk, and nothing else', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sink-'));
    const sink = await startNullS3({ saveDir: dir });
    const client = new S3Client({ region: 'us-east-1', endpoint: sink.endpoint, forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });
    await client.send(new PutObjectCommand({ Bucket: 'eval-BASE-review', Key: 'usage/2026-11-12/abc.json', Body: JSON.stringify({ servedModel: 'm' }) }));
    await client.send(new PutObjectCommand({ Bucket: 'eval-BASE-review', Key: 'review-run_x.json', Body: '{}' }));
    expect(sink.saved()).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'eval-BASE-review', 'usage', '2026-11-12', 'abc.json'), 'utf8'))).toEqual({ servedModel: 'm' });
    expect(fs.existsSync(path.join(dir, 'eval-BASE-review', 'review-run_x.json'))).toBe(false);
    const list = await client.send(new ListObjectsV2Command({ Bucket: 'eval-BASE-review', Prefix: 'usage/' }));
    expect(list.Contents ?? []).toHaveLength(0);
    await expect(client.send(new GetObjectCommand({ Bucket: 'b', Key: 'k' }))).rejects.toMatchObject({ name: 'NoSuchKey' });
    await sink.close();
  });
});

describe('storage scrubbing', () => {
  const parent = {
    S3_BUCKET: 'some-real-bucket', S3_ENDPOINT: 'https://real.example', S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 'sek',
    AWS_ACCESS_KEY_ID: 'AKIA2', AWS_SECRET_ACCESS_KEY: 'sek2', R2_TOKEN: 'r2', USAGE_INGEST_SHARED_SECRET: 'u', USAGE_INGEST_URL: 'https://x',
    FEEDBACK_SHARED_SECRET: 'f', EVALUATOR_SHARED_SECRET: 'e', GOOGLE_APPLICATION_CREDENTIALS: '/x.json', GEMINI_API_KEY: 'g', GITHUB_TOKEN: 't', PATH: '/bin',
  };

  it('removes every storage / ingest credential and keeps the Gemini and GitHub keys', () => {
    const env = { ...parent } as NodeJS.ProcessEnv;
    scrubStorageEnv(env);
    expect(Object.keys(env).sort()).toEqual(['GEMINI_API_KEY', 'GITHUB_TOKEN', 'PATH']);
  });

  it('a backend env never inherits the operator\'s bucket or credentials: it points at the sink, namespaced per arm', () => {
    const env = buildBackendEnv(parent, arms[2], 8103, 'http://127.0.0.1:5555');
    expect(env.S3_ENDPOINT).toBe('http://127.0.0.1:5555');
    expect(env.S3_BUCKET).toBe('eval-ARGON');
    expect(env.S3_REVIEW_BUCKET).toBe('eval-ARGON-review');
    expect(env.S3_ACCESS_KEY_ID).toBe('eval-null-sink');
    expect(JSON.stringify(env)).not.toMatch(/some-real-bucket|AKIA|sek|real\.example|USAGE_INGEST|FEEDBACK_SHARED|EVALUATOR_SHARED/);
    expect(env.GEMINI_API_KEY).toBe('g');
    expect(env.GITHUB_TOKEN).toBe('t');
  });

  it('with no sink given it still never keeps the real endpoint (falls back to a closed local port)', () => {
    const env = buildBackendEnv(parent, arms[0], 8101);
    expect(env.S3_ENDPOINT).toBe('http://127.0.0.1:9');
    expect(env.S3_BUCKET).not.toBe('some-real-bucket');
  });

  it('sinkEnv namespaces buckets by scope', () => {
    expect(sinkEnv('http://x', 'judge')).toMatchObject({ S3_BUCKET: 'eval-judge', S3_REVIEW_BUCKET: 'eval-judge-review' });
  });
});
