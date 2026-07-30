// Shared S3 helper for usage-report.js (repo root) — lists/reads/writes
// usage/ records in S3_REVIEW_BUCKET, the bucket adk/backend/src/usage.ts
// writes per-call token/latency/cost records to. Mirrors s3-debug-client.js
// in this same directory, but against a configurable (env-driven) bucket
// rather than a hardcoded one, since usage records live in a different
// bucket (S3_REVIEW_BUCKET) than that helper's eval-results bucket
// (S3_BUCKET).
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

function getClient() {
  return new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  });
}

function getBucketName() {
  return process.env.S3_REVIEW_BUCKET || 'gsr-review-results';
}

async function listFiles(prefix = '') {
  const result = await getClient().send(new ListObjectsV2Command({ Bucket: getBucketName(), Prefix: prefix }));
  return (result.Contents || []).map(obj => ({ name: obj.Key, size: obj.Size }));
}

async function downloadJson(key) {
  const result = await getClient().send(new GetObjectCommand({ Bucket: getBucketName(), Key: key }));
  const text = await result.Body.transformToString();
  return JSON.parse(text);
}

async function uploadJson(key, data) {
  await getClient().send(new PutObjectCommand({
    Bucket: getBucketName(),
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));
}

module.exports = { getBucketName, listFiles, downloadJson, uploadJson };
