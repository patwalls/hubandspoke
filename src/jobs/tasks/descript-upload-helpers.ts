import { createReadStream, createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { pipeline } from "stream/promises";

// Shared plumbing used by any task that moves bytes from S3 through a
// Descript signed upload URL: stream a presigned GET to disk, PUT the disk
// file back out with a correct Content-Length, and swallow missing-file
// errors during tempfile cleanup.

export async function downloadToFile(
  url: string,
  destPath: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`S3 download failed: HTTP ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as NodeReadableStream),
    createWriteStream(destPath),
  );
}

export async function putFileToUrl(
  filePath: string,
  url: string,
  contentType: string,
  contentLength: number,
): Promise<void> {
  const stream = createReadStream(filePath);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(contentLength),
    },
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Descript upload PUT failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    );
  }
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing tempfile on cleanup is fine — nothing to do.
  }
}
