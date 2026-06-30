import { createReadStream } from "fs";
import { stat } from "fs/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 — S3-compatible object storage. We reuse @aws-sdk/client-s3
// (already a dependency for the AWS S3 integration in ./s3.ts) but point a
// SEPARATE client at the R2 endpoint with EXPLICIT R2 credentials. This is
// deliberate: the default credential chain would otherwise pick up the app's
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY and sign R2 requests with the wrong
// keys. R2 is in the same Cloudflare account as the rest of our infra; storage
// is ~$0.015/GB-mo with zero egress, which is why it's attractive for heavy
// blobs we'd otherwise pay AWS egress on.

let _client: S3Client | null = null;

export function r2Client(): S3Client {
  if (_client) return _client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 not configured: set R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY"
    );
  }
  _client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    // Match ./s3.ts: keep the SDK from injecting a default CRC32 checksum that
    // breaks presigned PUTs (and that R2 doesn't require server-side either).
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return _client;
}

export function r2Bucket(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET not set");
  return b;
}

/** True when all R2 env vars are present — callers can degrade gracefully. */
export function hasR2(): boolean {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_BUCKET &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Stream a file on disk into R2 without buffering it whole (memory-safe). */
export async function putObjectFromFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const fileSize = (await stat(filePath)).size;
  await r2Client().send(
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      ContentLength: fileSize,
    })
  );
}

/** Read an object back as a Buffer; null if it doesn't exist. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    const res = await r2Client().send(
      new GetObjectCommand({ Bucket: r2Bucket(), Key: key })
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

export async function getPresignedGetUrl(
  key: string,
  ttlSeconds = 900,
  opts?: { downloadFileName?: string }
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
    ResponseContentDisposition: opts?.downloadFileName
      ? `attachment; filename="${opts.downloadFileName.replace(/"/g, "")}"`
      : undefined,
  });
  return getSignedUrl(r2Client(), cmd, { expiresIn: ttlSeconds });
}

export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  contentLength: number
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: r2Bucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(r2Client(), cmd, { expiresIn: 900 });
}

export async function deleteObject(key: string): Promise<void> {
  await r2Client().send(
    new DeleteObjectCommand({ Bucket: r2Bucket(), Key: key })
  );
}

export async function headObject(key: string): Promise<{
  contentLength?: number;
  contentType?: string;
} | null> {
  try {
    const res = await r2Client().send(
      new HeadObjectCommand({ Bucket: r2Bucket(), Key: key })
    );
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType,
    };
  } catch {
    return null;
  }
}
