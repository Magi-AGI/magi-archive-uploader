import * as fs from 'fs';
import * as crypto from 'crypto';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

let client: S3Client | null = null;

export function getS3(region: string): S3Client {
  if (!client) client = new S3Client({ region });
  return client;
}

/** Computes SHA-256 hex digest of a file by streaming. */
export async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

interface UploadResult {
  s3Key: string;
  uploadedAt: number;
}

/** Upload a single file. Uses multipart for files larger than threshold.
 *  Stores SHA-256 hex in object metadata so we can verify integrity post-upload. */
export async function uploadFile(opts: {
  bucket: string;
  region: string;
  s3Key: string;
  filePath: string;
  sha256Hex: string;
  multipartThreshold: number;
}): Promise<UploadResult> {
  const stat = fs.statSync(opts.filePath);
  const metadata = { 'sha256-hex': opts.sha256Hex };
  const s3 = getS3(opts.region);

  if (stat.size <= opts.multipartThreshold) {
    const body = fs.createReadStream(opts.filePath);
    await s3.send(new PutObjectCommand({
      Bucket: opts.bucket,
      Key: opts.s3Key,
      Body: body,
      Metadata: metadata,
    }));
  } else {
    const body = fs.createReadStream(opts.filePath);
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: opts.bucket,
        Key: opts.s3Key,
        Body: body,
        Metadata: metadata,
      },
      // Default partSize 5MB is fine; queueSize 4 is fine. Tune later if needed.
    });
    await upload.done();
  }

  return { s3Key: opts.s3Key, uploadedAt: Date.now() };
}

/** HEAD the object and confirm sha256-hex metadata + size match local. */
export async function verifyUpload(opts: {
  bucket: string;
  region: string;
  s3Key: string;
  expectedSha256Hex: string;
  expectedSize: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s3 = getS3(opts.region);
  const head = await s3.send(new HeadObjectCommand({
    Bucket: opts.bucket,
    Key: opts.s3Key,
  }));

  if (head.ContentLength !== opts.expectedSize) {
    return { ok: false, reason: `size mismatch: s3=${head.ContentLength} local=${opts.expectedSize}` };
  }

  const stored = head.Metadata?.['sha256-hex'];
  if (!stored) {
    return { ok: false, reason: 'sha256-hex metadata missing on S3 object' };
  }
  if (stored.toLowerCase() !== opts.expectedSha256Hex.toLowerCase()) {
    return { ok: false, reason: `sha256 mismatch: s3=${stored} local=${opts.expectedSha256Hex}` };
  }
  return { ok: true };
}
