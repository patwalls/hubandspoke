"use client";

/**
 * Browser-side multipart upload helper.
 *
 * Splits a File into 10 MB chunks and uploads each chunk to S3 via a
 * per-part presigned PUT URL. Parts are uploaded sequentially so a single
 * stalled TCP connection only delays one part instead of the whole file.
 *
 * Requires the S3 bucket CORS policy to expose the ETag response header:
 *   "ExposeHeaders": ["ETag", "Content-Length"]
 *
 * Callers are responsible for creating the multipart upload first
 * (POST /api/uploads/multipart/create → { uploadId, key }) and completing
 * or aborting it afterward.
 */

const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB per part

export interface MultipartUploadArgs {
  file: File;
  uploadId: string;
  key: string;
  /** The storage bucket the upload was created in — passed to presign-part
   *  so the server routes to the right storage backend (S3 vs R2). */
  bucket: string;
  /** Called with 0–100 as parts complete. */
  onProgress?: (percent: number) => void;
}

export interface MultipartPart {
  PartNumber: number;
  ETag: string;
}

/** PUT a single chunk to a presigned S3 URL via XHR. Returns the ETag. */
function putPart(args: {
  url: string;
  chunk: Blob;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", args.url, true);
    // S3 multipart parts don't need a Content-Type; sending application/octet-stream
    // avoids the browser pre-flighting a CORS OPTIONS request per-part.
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) args.onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) {
          reject(
            new Error(
              "S3 did not return an ETag. Check that the bucket CORS policy " +
                'includes "ETag" in ExposeHeaders.',
            ),
          );
        } else {
          resolve(etag);
        }
      } else {
        reject(new Error(`Part upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Part upload failed (network error)"));
    xhr.onabort = () => reject(new Error("Part upload aborted"));
    xhr.send(args.chunk);
  });
}

/**
 * Upload all parts of a file sequentially.
 *
 * Returns the ordered [{PartNumber, ETag}] array needed by
 * POST /api/uploads/multipart/complete.
 *
 * Throws on any part failure — the caller should then call
 * POST /api/uploads/multipart/abort to clean up S3 state.
 */
export async function runMultipartUpload(
  args: MultipartUploadArgs,
): Promise<MultipartPart[]> {
  const { file, uploadId, key, bucket, onProgress } = args;
  const totalParts = Math.ceil(file.size / CHUNK_SIZE);
  const parts: MultipartPart[] = [];
  let bytesUploadedBeforeCurrentPart = 0;

  for (let i = 0; i < totalParts; i++) {
    const partNumber = i + 1;
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const partBytes = end - start;

    // Presign this part. Pass bucket so the server routes to the right backend.
    const presignRes = await fetch("/api/uploads/multipart/presign-part", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, uploadId, partNumber, bucket }),
    });
    const presignJson = (await presignRes.json().catch(() => ({}))) as {
      url?: string;
      error?: string;
    };
    if (!presignRes.ok || !presignJson.url) {
      throw new Error(presignJson.error || `Failed to presign part ${partNumber}`);
    }

    // Upload the chunk with per-byte progress folded into overall progress.
    const etag = await putPart({
      url: presignJson.url,
      chunk,
      onProgress: (loaded) => {
        const totalUploaded = bytesUploadedBeforeCurrentPart + loaded;
        onProgress?.(Math.round((totalUploaded / file.size) * 100));
      },
    });

    parts.push({ PartNumber: partNumber, ETag: etag });
    bytesUploadedBeforeCurrentPart += partBytes;
  }

  return parts;
}
