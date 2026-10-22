// Screenshots for any newsletter draft. A section whose template setting asks
// for screenshots gets `*[Screenshot @ M:SS: …]*` placeholders from the
// drafter; each placeholder's video is the issue's video (single-video
// formats) or its section's story video (roundups). Frames come from the
// design editor's frame-grab task — `design-frames` on the media-heavy queue,
// rows in design_frames keyed by the video — and the pick per placeholder is
// saved on newsletter_drafts.screenshots.
//
// When a draft or a regenerated section lands, autoPickScreenshots grabs the
// frame at each placeholder's moment and picks it (`source: "auto"`, pending
// until the worker has the frame); resolvePendingScreenshots fills those in
// as frames finish, whenever the draft is read or pushed. The editor can swap
// any pick (another frame, a scrubbed moment, an upload) or remove it. The
// email pushes swap picks in for their placeholders (beehiiv-draft.ts,
// hubspot-newsletter-create-draft.ts).

import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designFrames, newsletterDrafts } from "@/lib/db/schema";
import { listFrames, requestFrameAt, type DesignFrame } from "@/lib/services/design-editor/frames";
import { loadSource } from "@/lib/services/design-editor/session";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { parseScreenshotMarks, type ChosenScreenshot } from "@/lib/newsletter-screenshots";
import type { NewsletterSection } from "@/lib/newsletter-template";

/** Candidate moments around a placeholder's timestamp: just before, on it, just after. Pure; exported for tests. */
export function frameCandidateSecs(sec: number): number[] {
  return [...new Set([Math.max(0, sec - 2), Math.max(0, sec), sec + 3])];
}

/**
 * The video a section's screenshots come from: the issue's video when the
 * draft has one, else the section's story when it's a video. Null = no video
 * (a case study): upload only. Pure; exported for tests.
 */
export function sectionVideoId(draft: { sourceItemId: string | null }, section: Pick<NewsletterSection, "source"> | undefined): string | null {
  if (draft.sourceItemId) return draft.sourceItemId;
  const key = section?.source?.kind === "video" ? section.source.key : null;
  return key?.startsWith("video:") ? key.slice("video:".length) : null;
}

/** Every placeholder in the draft → the video its frames come from. Pure; exported for tests. */
export function placeholderVideos(draft: { sourceItemId: string | null; sections: NewsletterSection[] }): Map<string, { videoId: string | null; sec: number | null }> {
  const out = new Map<string, { videoId: string | null; sec: number | null }>();
  for (const s of draft.sections) {
    const videoId = sectionVideoId(draft, s);
    for (const m of parseScreenshotMarks(s.key, s.markdown)) out.set(m.key, { videoId, sec: m.sec });
  }
  return out;
}

interface DraftShots {
  sourceItemId: string | null;
  sections: NewsletterSection[];
  screenshots: Record<string, ChosenScreenshot>;
}

async function loadDraft(draftId: string): Promise<DraftShots | null> {
  const [d] = await db
    .select({ sourceItemId: newsletterDrafts.sourceItemId, sections: newsletterDrafts.sections, screenshots: newsletterDrafts.screenshots })
    .from(newsletterDrafts)
    .where(eq(newsletterDrafts.id, draftId))
    .limit(1);
  return d ?? null;
}

async function saveChosen(draftId: string, chosen: Record<string, ChosenScreenshot>): Promise<void> {
  await db
    .update(newsletterDrafts)
    .set({ screenshots: sql`${JSON.stringify(chosen)}::jsonb`, updatedAt: new Date() })
    .where(eq(newsletterDrafts.id, draftId));
}

function fromFrame(f: typeof designFrames.$inferSelect, source: ChosenScreenshot["source"]): ChosenScreenshot {
  const done = f.status === "done" && !!f.s3Key;
  return { frameId: f.id, sec: Number(f.sec), bucket: done ? (f.s3Bucket ?? defaultBucket()) : "", key: done ? f.s3Key! : "", source, ...(done ? {} : { pending: true }) };
}

/**
 * Grab the frame at each placeholder's moment and pick it, for placeholders
 * that have a moment and a video and nothing picked yet. Free (ffmpeg on our
 * worker). Idempotent: picks already made (by hand or earlier) are kept.
 */
export async function autoPickScreenshots(draftId: string): Promise<number> {
  const d = await loadDraft(draftId);
  if (!d) return 0;
  const next = { ...d.screenshots };
  let added = 0;
  for (const [markKey, { videoId, sec }] of placeholderVideos(d)) {
    if (next[markKey] || !videoId || sec == null) continue;
    if (!(await loadSource(videoId))) continue; // no archived video file to grab from
    const f = await requestFrameAt(videoId, sec);
    const [row] = await db.select().from(designFrames).where(eq(designFrames.id, f.id)).limit(1);
    if (!row) continue;
    next[markKey] = fromFrame(row, "auto");
    added++;
  }
  if (added) await saveChosen(draftId, next);
  return added;
}

/** Forget a section's picks (its story — so its video — changed). */
export async function dropSectionScreenshots(draftId: string, sectionKey: string): Promise<void> {
  const d = await loadDraft(draftId);
  if (!d) return;
  const next = Object.fromEntries(Object.entries(d.screenshots).filter(([k]) => !k.startsWith(`${sectionKey}:`)));
  if (Object.keys(next).length !== Object.keys(d.screenshots).length) await saveChosen(draftId, next);
}

/**
 * After a draft or a section lands: pick frames for its new placeholders.
 * Never fails the caller (a missing archive or a queue hiccup just leaves
 * the placeholders for the editor).
 */
export async function autoPickScreenshotsSafely(draftId: string, log?: (msg: string) => void): Promise<void> {
  try {
    const n = await autoPickScreenshots(draftId);
    if (n) log?.(`screenshots: auto-picking ${n} frame(s)`);
  } catch (err) {
    log?.(`screenshots: auto-pick skipped: ${(err as Error).message}`);
  }
}

/** Fill in picks whose frame was still being grabbed; drop ones whose grab failed. Returns the current picks. */
export async function resolvePendingScreenshots(draftId: string, chosen?: Record<string, ChosenScreenshot>): Promise<Record<string, ChosenScreenshot>> {
  const current = chosen ?? (await loadDraft(draftId))?.screenshots ?? {};
  const pending = Object.entries(current).filter(([, c]) => c.pending && c.frameId);
  if (!pending.length) return current;
  const rows = await db
    .select()
    .from(designFrames)
    .where(inArray(designFrames.id, pending.map(([, c]) => c.frameId!)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = { ...current };
  let changed = false;
  for (const [markKey, c] of pending) {
    const row = byId.get(c.frameId!);
    if (!row || row.status === "failed") {
      delete next[markKey];
      changed = true;
    } else if (row.status === "done" && row.s3Key) {
      next[markKey] = fromFrame(row, c.source);
      changed = true;
    }
  }
  if (changed) await saveChosen(draftId, next);
  return next;
}

/** The video a placeholder's frames come from (null: the placeholder is gone, or its section has no video). */
async function placeholderVideo(d: DraftShots, markKey: string): Promise<string | null> {
  return placeholderVideos(d).get(markKey)?.videoId ?? null;
}

/** Queue frame grabs around `sec` of a placeholder's video (idempotent per moment). */
export async function requestScreenshotFrames(draftId: string, markKey: string, sec: number): Promise<DesignFrame[] | { error: string }> {
  const d = await loadDraft(draftId);
  if (!d) return { error: "Draft not found" };
  const videoId = await placeholderVideo(d, markKey);
  if (!videoId) return { error: "This section has no video to grab from. Upload an image instead." };
  return Promise.all(frameCandidateSecs(sec).map((s) => requestFrameAt(videoId, s)));
}

/** "Use this frame" from the scrubber: grab exactly `sec` and pick it (filled in once the worker has it). */
export async function grabScreenshotAt(draftId: string, markKey: string, sec: number): Promise<{ ok: true } | { error: string }> {
  const d = await loadDraft(draftId);
  if (!d) return { error: "Draft not found" };
  const videoId = await placeholderVideo(d, markKey);
  if (!videoId) return { error: "This section has no video to grab from. Upload an image instead." };
  const f = await requestFrameAt(videoId, sec);
  const [row] = await db.select().from(designFrames).where(eq(designFrames.id, f.id)).limit(1);
  if (!row) return { error: "Couldn't grab that frame" };
  await saveChosen(draftId, { ...d.screenshots, [markKey]: fromFrame(row, "frame") });
  return { ok: true };
}

export interface ScreenshotState {
  /** Frames grabbed by hand (or for picks) from the draft's videos, each with its video. */
  frames: (DesignFrame & { videoId: string })[];
  chosen: Record<string, ChosenScreenshot>;
  previews: Record<string, string>;
  /** Placeholder → its video id (null: no video, upload only). */
  marks: Record<string, string | null>;
  /** Video id → a short-lived link to the archived video, for the scrubber. */
  videoUrls: Record<string, string>;
}

/** Everything the editor's screenshot panel needs. */
export async function listScreenshotFrames(draftId: string): Promise<ScreenshotState | null> {
  const d = await loadDraft(draftId);
  if (!d) return null;
  const chosen = await resolvePendingScreenshots(draftId, d.screenshots);
  const marks = Object.fromEntries([...placeholderVideos(d)].map(([k, v]) => [k, v.videoId]));
  const videoIds = [...new Set(Object.values(marks).filter((v): v is string => !!v))];
  const frames: ScreenshotState["frames"] = [];
  const videoUrls: Record<string, string> = {};
  for (const videoId of videoIds) {
    const [{ frames: fs }, src] = await Promise.all([listFrames(videoId), loadSource(videoId)]);
    frames.push(...fs.filter((f) => f.origin === "user").map((f) => ({ ...f, videoId })));
    if (src) videoUrls[videoId] = await getPresignedGetUrl(src.key, 4 * 3600, { bucket: src.bucket ?? undefined });
  }
  frames.sort((a, b) => a.sec - b.sec);
  return { frames, chosen, previews: await screenshotPreviewUrls(chosen), marks, videoUrls };
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
  const d = await loadDraft(draftId);
  if (!d) return { error: "Draft not found" };
  const key = buildKey(`newsletter-screenshots/${draftId}`, file.name.replace(/\.[a-z0-9]+$/i, "") + `.${ext}`);
  await putObject(key, file.bytes, file.type);
  await saveChosen(draftId, { ...d.screenshots, [markKey]: { frameId: null, sec: null, bucket: bucketName(), key, source: "upload" } });
  return { ok: true };
}

/** Pick (or clear, with frameId null) the frame for one placeholder. */
export async function chooseScreenshot(draftId: string, markKey: string, frameId: string | null): Promise<{ ok: true } | { error: string }> {
  const d = await loadDraft(draftId);
  if (!d) return { error: "Draft not found" };
  const next = { ...d.screenshots };
  if (frameId) {
    const [f] = await db.select().from(designFrames).where(eq(designFrames.id, frameId)).limit(1);
    if (!f || f.productionItemId !== (await placeholderVideo(d, markKey))) return { error: "That frame isn't from this section's video" };
    if (f.status !== "done" || !f.s3Key) return { error: "That frame isn't ready yet" };
    next[markKey] = fromFrame(f, "frame");
  } else {
    delete next[markKey];
  }
  await saveChosen(draftId, next);
  return { ok: true };
}

function defaultBucket(): string {
  return process.env.HUBANDSPOKE_S3_BUCKET ?? "";
}

/**
 * A link the email tool can load the image from. The frames bucket
 * (www.starterstory.com) serves objects publicly, so that's a permanent S3
 * URL; any other bucket gets a 7-day signed link (beehiiv copies images to its
 * CDN at create time).
 */
export async function publicScreenshotUrl(c: ChosenScreenshot): Promise<string> {
  if (c.bucket === "www.starterstory.com") {
    const region = process.env.AWS_REGION ?? "us-east-1";
    return `https://s3.${region}.amazonaws.com/${c.bucket}/${c.key.split("/").map(encodeURIComponent).join("/")}`;
  }
  return getPresignedGetUrl(c.key, 7 * 24 * 3600, { bucket: c.bucket || undefined });
}

/** Public links for every ready pick, keyed by S3 key (what the email builders look up). */
export async function screenshotUrlsByKey(chosen: Record<string, ChosenScreenshot>): Promise<Record<string, string>> {
  const ready = Object.values(chosen).filter((c) => c.key && !c.pending);
  return Object.fromEntries(await Promise.all(ready.map(async (c) => [c.key, await publicScreenshotUrl(c)] as const)));
}

/** Short-lived preview links for the editor (ready picks only). */
export async function screenshotPreviewUrls(chosen: Record<string, ChosenScreenshot>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, c] of Object.entries(chosen)) if (c.key && !c.pending) out[k] = await getPresignedGetUrl(c.key, 4 * 3600, { bucket: c.bucket || undefined });
  return out;
}
