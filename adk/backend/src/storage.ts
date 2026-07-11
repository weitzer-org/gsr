import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

export interface StoredFile {
  name: string;
  updated?: string;
  size?: number;
  metadata?: Record<string, string>;
}

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

export async function uploadJson(bucket: string, key: string, data: unknown, metadata?: Record<string, string>): Promise<void> {
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
    Metadata: metadata,
  }));
}

// `includeMetadata` costs one HeadObject call per file — only set it where
// custom metadata (e.g. originalUrl) actually needs to be displayed in a
// list view, since S3 ListObjectsV2 (unlike GCS) doesn't return it inline.
export async function listFiles(bucket: string, prefix: string, options?: { maxResults?: number; includeMetadata?: boolean }): Promise<StoredFile[]> {
  const result = await getClient().send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: options?.maxResults,
  }));

  const files = (result.Contents || [])
    .filter(obj => obj.Key && obj.Key !== prefix)
    .map(obj => ({
      name: obj.Key!,
      updated: obj.LastModified?.toISOString(),
      size: obj.Size,
    }));

  if (!options?.includeMetadata) {
    return files;
  }

  return Promise.all(files.map(async (file) => {
    const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: file.name }));
    return { ...file, metadata: head.Metadata };
  }));
}

export async function getFileStream(bucket: string, key: string): Promise<Readable> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return result.Body as Readable;
}
