// Screenshots for a How-To draft: grab candidate frames from the archived
// source video around a placeholder's timestamp (the design editor's
// frame-grab task — `design-frames` on the media-heavy queue, rows in
// design_frames keyed by the video), list them for the editor, and save the
// editor's pick on newsletter_drafts.screenshots. The beehiiv push swaps
// picked frames in for their placeholders (beehiiv-draft.ts).

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designFrames, newsletterDrafts } from "@/lib/db/schema";
import { listFrames, requestFrameAt, type DesignFrame } from "@/lib/services/design-editor/frames";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import type { ChosenScreenshot } from "@/lib/newsletter-screenshots";

/** Candidate moments around a placeholder's timestamp: just before, on it, just after. Pure; exported for tests. */
export function frameCandidateSecs(sec: number): number[] {
  return [...new Set([Math.max(0, sec - 2), Math.max(0, sec), sec + 3])];
}

async function draftVideo(draftId: string): Promise<{ sourceItemId: string; screenshots: Record<string, ChosenScreenshot> } | null> {
  const [d] = await db
    .select({ sourceItemId: newsletterDrafts.sourceItemId, screenshots: newsletterDrafts.screenshots })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  return d?.sourceItemId ? { sourceItemId: d.sourceItemId, screenshots: d.screenshots } : null;
}

/** Queue frame grabs around `sec` (idempotent per moment). Null = the draft has no source video. */
export async function requestScreenshotFrames(draftId: string, sec: number): Promise<DesignFrame[] | null> {
  const d = await draftVideo(draftId);
  if (!d) return null;
  return Promise.all(frameCandidateSecs(sec).map((s) => requestFrameAt(d.sourceItemId, s)));
}

/** Every frame grabbed at a chosen moment of the draft's video (with preview links), plus the picks and their previews. */
export async function listScreenshotFrames(
  draftId: string,
): Promise<{ frames: DesignFrame[]; chosen: Record<string, ChosenScreenshot>; previews: Record<string, string> } | null> {
  const d = await draftVideo(draftId);
  if (!d) return null;
  const { frames } = await listFrames(d.sourceItemId);
  return {
    frames: frames.filter((f) => f.origin === "user").sort((a, b) => a.sec - b.sec),
    chosen: d.screenshots,
    previews: await screenshotPreviewUrls(d.screenshots),
  };
}

export const SCREENSHOT_UPLOAD_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
export const SCREENSHOT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Use an uploaded image for one placeholder (replacing any frame or earlier upload). */
export async function uploadScreenshot(
  draftId: string,
  markKey: string,
  file: { name: string; type: string; bytes: Uint8Array },
): Promise<{ ok: true } | { error: string }> {
  const ext = SCREENSHOT_UPLOAD_TYPES[file.type];
  if (!ext) return { error: "Upload a PNG, JPG, WebP or GIF" };
  if (file.bytes.byteLength > SCREENSHOT_UPLOAD_MAX_BYTES) return { error: "Images up to 10 MB" };
  const [d] = await db.select({ screenshots: newsletterDrafts.screenshots }).from(newsletterDrafts).where(eq(newsletterDrafts.id, draftId)).limit(1);
  if (!d) return { error: "Draft not found" };
  const key = buildKey(`newsletter-screenshots/${draftId}`, file.name.replace(/\.[a-z0-9]+$/i, "") + `.${ext}`);
  await putObject(key, file.bytes, file.type);
  const next = { ...d.screenshots, [markKey]: { frameId: null, sec: null, bucket: bucketName(), key, source: "upload" as const } };
  await db
    .update(newsletterDrafts)
    .set({ screenshots: sql`${JSON.stringify(next)}::jsonb`, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, draftId));
  return { ok: true };
}

/** Pick (or clear, with frameId null) the frame for one placeholder. */
export async function chooseScreenshot(draftId: string, markKey: string, frameId: string | null): Promise<{ ok: true } | { error: string }> {
  const d = await draftVideo(draftId);
  if (!d) return { error: "This draft has no source video" };
  const next = { ...d.screenshots };
  if (frameId) {
    const [f] = await db.select().from(designFrames).where(eq(designFrames.id, frameId)).limit(1);
    if (!f || f.productionItemId !== d.sourceItemId) return { error: "That frame isn't from this draft's video" };
    if (f.status !== "done" || !f.s3Key) return { error: "That frame isn't ready yet" };
    next[markKey] = { frameId: f.id, sec: Number(f.sec), bucket: f.s3Bucket ?? defaultBucket(), key: f.s3Key, source: "frame" };
  } else {
    delete next[markKey];
  }
  await db
    .update(newsletterDrafts)
    .set({ screenshots: sql`${JSON.stringify(next)}::jsonb`, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, draftId));
  return { ok: true };
}

function defaultBucket(): string {
  return process.env.HUBANDSPOKE_S3_BUCKET ?? "";
}

/**
 * A link beehiiv can load the frame from. The frames bucket
 * (www.starterstory.com) serves objects publicly, so that's a permanent S3
 * URL; any other bucket gets a 7-day signed link (long enough for beehiiv to
 * fetch it at create time).
 */
export async function publicScreenshotUrl(c: ChosenScreenshot): Promise<string> {
  if (c.bucket === "www.starterstory.com") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    return `https://s3.${region}.amazonaws.com/${c.bucket}/${c.key.split("/").map(encodeURIComponent).join("/")}`;
  }
  return getPresignedGetUrl(c.key, 7 * 24 * 3600, { bucket: c.bucket || undefined });
}

/** Short-lived preview links for the editor (picked frames only). */
export async function screenshotPreviewUrls(chosen: Record<string, ChosenScreenshot>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, c] of Object.entries(chosen)) out[k] = await getPresignedGetUrl(c.key, 4 * 3600, { bucket: c.bucket || undefined });
  return out;
}
