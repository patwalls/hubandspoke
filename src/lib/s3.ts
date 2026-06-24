import { randomUUID } from "crypto";
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

export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Stream a file on disk into S3. Used by the precise-cut worker to upload
 * the ffmpeg-trimmed clip without loading the whole thing into memory —
 * graphile_worker dynos run at Heroku Basic 512 MB and a 30 MB Buffer +
 * the same data flowing through the SDK's internal copy chain has been
 * enough to trigger R14 (memory quota exceeded) under load.
 */
export async function putObjectFromFile(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  const fileSize = (await stat(filePath)).size;
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      ContentLength: fileSize,
    })
  );
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

export async function deleteObject(key: string): Promise<void> {
  await s3Client().send(
    new DeleteObjectCommand({ Bucket: bucketName(), Key: key })
  );
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
