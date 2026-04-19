import { randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let _client: S3Client | null = null;

export function s3Client(): S3Client {
  if (_client) return _client;
  const region = process.env.AWS_REGION || "us-east-1";
  _client = new S3Client({ region });
  return _client;
}

export function bucketName(): string {
  const b = process.env.HUBANDSPOKE_S3_BUCKET;
  if (!b) throw new Error("HUBANDSPOKE_S3_BUCKET not set");
  return b;
}

function keyPrefix(): string {
  return (process.env.HUBANDSPOKE_S3_PREFIX || "hubandspoke/uploads").replace(
    /\/+$/,
    ""
  );
}

// Build a stable object key: <prefix>/<itemId>/<uuid>-<safeName>.
// The uuid prefix prevents collisions when the same file name is uploaded
// twice; the original (sanitized) name is kept for human debugging in the
// S3 console.
export function buildKey(itemId: string, fileName: string): string {
  const safe = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
  return `${keyPrefix()}/${itemId}/${randomUUID()}-${safe}`;
}

export async function getPresignedPutUrl(
  key: string,
  contentType: string,
  contentLength: number
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(s3Client(), cmd, { expiresIn: 900 });
}

export async function getPresignedGetUrl(
  key: string,
  ttlSeconds = 900,
  opts?: { downloadFileName?: string }
): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: bucketName(),
    Key: key,
    // Force browser to download instead of playing in-tab when set.
    ResponseContentDisposition: opts?.downloadFileName
      ? `attachment; filename="${opts.downloadFileName.replace(/"/g, "")}"`
      : undefined,
  });
  return getSignedUrl(s3Client(), cmd, { expiresIn: ttlSeconds });
}

export async function headObject(key: string): Promise<{
  contentLength?: number;
  contentType?: string;
} | null> {
  try {
    const res = await s3Client().send(
      new HeadObjectCommand({ Bucket: bucketName(), Key: key })
    );
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType,
    };
  } catch {
    return null;
  }
}
