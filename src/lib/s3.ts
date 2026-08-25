import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ---------------------------------------------------------------------------
// AWS S3 client
// ---------------------------------------------------------------------------

let _client: S3Client | null = null;

export function s3Client(): S3Client {
  if (_client) return _client;
  const region = process.env.AWS_REGION || "us-east-1";
  // `requestChecksumCalculation: "WHEN_REQUIRED"` is critical for the
  // browser-upload flow. Since @aws-sdk/client-s3 v3.729 the SDK injects a
  // default CRC32 integrity checksum into every PutObject. When we *presign*
  // a PutObjectCommand (getPresignedPutUrl), the checksum is computed over the
  // empty signing-time body and baked into the URL as
  // `x-amz-checksum-crc32=AAAAAA==` (CRC32 of zero bytes). The browser then
  // streams the real file, S3 validates it against "checksum of empty", and
  // the connection dies mid-upload — the progress bar freezes partway and
  // never completes. "WHEN_REQUIRED" stops the SDK from adding that checksum
  // unless the operation actually requires one, which fixes presigned PUTs.
  // Safe for our server-side uploads too (S3 doesn't require checksums there).
  _client = new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED" });
  return _client;
}

export function bucketName(): string {
  const b = process.env.HUBANDSPOKE_S3_BUCKET;
  if (!b) throw new Error("HUBANDSPOKE_S3_BUCKET not set");
  return b;
}

// ---------------------------------------------------------------------------
// Cloudflare R2 client (S3-compatible)
// ---------------------------------------------------------------------------

let _r2Client: S3Client | null = null;

function r2Client(): S3Client {
  if (_r2Client) return _r2Client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2 credentials not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)",
    );
  }
  _r2Client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return _r2Client;
}

export function r2BucketName(): string {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET not set");
  return b;
}

// ---------------------------------------------------------------------------
// Routing: pick S3 or R2 based on the bucket name stored with the object.
// ---------------------------------------------------------------------------

function clientForBucket(bucket: string): S3Client {
  try {
    if (bucket === r2BucketName()) return r2Client();
  } catch {
    // R2 not configured — fall through to S3.
  }
  return s3Client();
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

/**
 * Stream a Node.js Readable directly to S3. Use this for large remote files
 * that exceed the safe in-memory buffer threshold — it never loads the body
 * into a Buffer, so it won't blow the Heroku Basic dyno's 512 MB RAM cap.
 * `contentLength` must come from the HTTP Content-Length header; S3 requires
 * it for non-multipart PutObject requests.
 */
export async function putObjectFromStream(
  key: string,
  stream: Readable,
  contentType: string,
  contentLength: number
): Promise<void> {
  await s3Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: stream,
      ContentType: contentType,
      ContentLength: contentLength,
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
  opts?: { downloadFileName?: string; bucket?: string }
): Promise<string> {
  const bucket = opts?.bucket ?? bucketName();
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    // Force browser to download instead of playing in-tab when set.
    ResponseContentDisposition: opts?.downloadFileName
      ? `attachment; filename="${opts.downloadFileName.replace(/"/g, "")}"`
      : undefined,
  });
  return getSignedUrl(clientForBucket(bucket), cmd, { expiresIn: ttlSeconds });
}

export async function deleteObject(key: string): Promise<void> {
  await s3Client().send(
    new DeleteObjectCommand({ Bucket: bucketName(), Key: key })
  );
}

export async function headObject(
  key: string,
  bucket = bucketName(),
): Promise<{ contentLength?: number; contentType?: string } | null> {
  try {
    const res = await clientForBucket(bucket).send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    return {
      contentLength: res.ContentLength,
      contentType: res.ContentType,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multipart upload helpers (used by /api/uploads/multipart/* routes)
// ---------------------------------------------------------------------------

export async function createMultipartUpload(
  key: string,
  contentType: string,
  bucket = bucketName(),
): Promise<string> {
  const res = await clientForBucket(bucket).send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
    })
  );
  if (!res.UploadId) throw new Error("S3 did not return an UploadId");
  return res.UploadId;
}

export async function presignUploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  expiresIn = 3600,
  bucket = bucketName(),
): Promise<string> {
  const cmd = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(clientForBucket(bucket), cmd, { expiresIn });
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>,
  bucket = bucketName(),
): Promise<void> {
  await clientForBucket(bucket).send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
  bucket = bucketName(),
): Promise<void> {
  try {
    await clientForBucket(bucket).send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      })
    );
  } catch {
    // Best-effort cleanup — swallow errors so the caller isn't blocked.
  }
}
