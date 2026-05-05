import { createWriteStream } from "fs";
import { unlink } from "fs/promises";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { pipeline } from "stream/promises";

// Shared plumbing for tasks that download from S3 to a local tempfile and
// clean it up afterwards.

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

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing tempfile on cleanup is fine — nothing to do.
  }
}
