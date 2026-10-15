import { unlink } from "fs/promises";

// Shared plumbing for tasks that download from S3 to a local tempfile and
// clean it up afterwards.

// Bounded download (10 min default, abortable) — see ffmpeg-process.ts for why
// every task-side download must have a timeout.
export { downloadToFile } from "@/lib/services/ffmpeg-process";

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing tempfile on cleanup is fine — nothing to do.
  }
}
