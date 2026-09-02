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
//
// When `maxResults` is omitted, the caller wants EVERY object under
// `prefix`, not just whatever fits in one page — S3/R2's ListObjectsV2 caps
// a single response at 1000 keys regardless of whether MaxKeys is set, so
// this loops via ContinuationToken until IsTruncated is false. Silently
// stopping after the first page here previously dropped every object past
// the 1000th with no error or warning: usage.ts's listUsageRecords (the
// only caller that omits maxResults, since it needs a date's complete set
// of records to aggregate a correct rollup) was undercounting any date
// with 1000+ calls — confirmed in production on 2026-08-30 for two
// high-volume days after a historical backfill pushed several dates over
// that threshold. Callers that pass an explicit `maxResults` (recent-
// history UI views capped at e.g. 100) keep today's single-capped-call
// behavior unchanged — they want a bounded page, not "everything".
export async function listFiles(bucket: string, prefix: string, options?: { maxResults?: number; includeMetadata?: boolean }): Promise<StoredFile[]> {
  const paginate = options?.maxResults === undefined;
  const contents: { Key?: string; LastModified?: Date; Size?: number }[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await getClient().send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: options?.maxResults,
      ContinuationToken: continuationToken,
    }));
    contents.push(...(result.Contents || []));
    continuationToken = paginate && result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  const files = contents
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
    try {
      const head = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: file.name }));
      return { ...file, metadata: head.Metadata };
    } catch (error) {
      console.error(`Failed to fetch metadata for ${file.name}:`, error);
      return file;
    }
  }));
}

export async function getFileStream(bucket: string, key: string): Promise<Readable> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return result.Body as Readable;
}

// getFileJson reads and parses a JSON object, returning undefined when the
// key doesn't exist OR when its content isn't valid JSON, rather than
// throwing — used by callers (e.g. usage.ts's rollup cache) that treat
// either case as a normal "nothing usable here yet" outcome to rebuild
// from, not an error. S3 transport/auth errors still propagate.
export async function getFileJson(bucket: string, key: string): Promise<unknown | undefined> {
  let result;
  try {
    result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error: any) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) {
      return undefined;
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return undefined;
  }
}
