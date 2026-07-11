import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

let client: S3Client | undefined;

// Works against any S3-compatible store: Cloudflare R2 (prod), MinIO (local
// Docker dev), or AWS S3. Path-style addressing keeps MinIO and custom
// endpoints working without per-bucket virtual-hosted DNS.
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      },
    });
  }
  return client;
}

/**
 * Uploads a JSON object to an S3-compatible bucket.
 */
export async function uploadResultsToGCS(bucketName: string, destFileName: string, jsonData: any): Promise<void> {
  try {
    console.log(`Uploading results to s3://${bucketName}/${destFileName}...`);

    await getClient().send(new PutObjectCommand({
      Bucket: bucketName,
      Key: destFileName,
      Body: JSON.stringify(jsonData, null, 2),
      ContentType: 'application/json',
    }));

    console.log('✅ Upload complete.');
  } catch (error) {
    console.error('Failed to upload results to storage.', error);
    throw error;
  }
}

/**
 * Ensures a bucket exists, creating it if necessary.
 */
export async function ensureBucketExists(bucketName: string): Promise<void> {
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`ℹ️ Bucket ${bucketName} already exists.`);
  } catch (error) {
    console.log(`Bucket ${bucketName} does not exist. Creating it...`);
    await getClient().send(new CreateBucketCommand({ Bucket: bucketName }));
    console.log(`✅ Created bucket ${bucketName}.`);
  }
}

export async function listFiles(bucketName: string, prefix: string): Promise<{ name: string; updated?: string; size?: number }[]> {
  const result = await getClient().send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }));
  return (result.Contents || [])
    .filter(obj => obj.Key && obj.Key !== prefix)
    .map(obj => ({ name: obj.Key!, updated: obj.LastModified?.toISOString(), size: obj.Size }));
}

export async function downloadFile(bucketName: string, key: string): Promise<string> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
  return (await result.Body?.transformToString()) || '';
}
