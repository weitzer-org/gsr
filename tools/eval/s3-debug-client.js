// Shared helper for the one-off debug/analysis scripts in this directory
// (list-gcs.js, check-prs.js, etc.) — talks to whatever S3-compatible bucket
// S3_* env vars point at (Cloudflare R2 in prod, MinIO locally).
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

const bucketName = process.env.S3_BUCKET || 'gsr-eval-results';

const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
});

async function listFiles(prefix = '') {
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }));
  return (result.Contents || []).map(obj => ({
    name: obj.Key,
    updated: obj.LastModified ? obj.LastModified.toISOString() : undefined,
    size: obj.Size,
  }));
}

async function downloadFile(key) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  return result.Body.transformToString();
}

module.exports = { bucketName, listFiles, downloadFile };
