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

import Anthropic from "@anthropic-ai/sdk";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designFrames, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { listFrames, requestFrameAt, requestFramesAt, type DesignFrame } from "@/lib/services/design-editor/frames";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import { loadSource } from "@/lib/services/design-editor/session";
import { bucketName, buildKey, getPresignedGetUrl, putObject } from "@/lib/s3";
import { formatTimestamp, parseScreenshotMarks, parseTimestamp, type ChosenScreenshot } from "@/lib/newsletter-screenshots";
import type { NewsletterSection } from "@/lib/newsletter-template";
import { youtubeThumbnailUrl } from "./sources";

/** Candidate moments around a placeholder's timestamp: just before, on it, just after. Pure; exported for tests. */
export function frameCandidateSecs(sec: number): number[] {
  return [...new Set([Math.max(0, sec - 2), Math.max(0, sec), sec + 3])];
}

/**
 * The moments the picker offers for a placeholder: 12 frames, every 4 seconds
 * from just before its timestamp to 40s after (where that step is usually
 * still on screen), never before 0:00. Pure; exported for tests.
 */
export function screenshotWindowSecs(sec: number): number[] {
  return [...new Set(Array.from({ length: 12 }, (_, i) => Math.max(0, Math.round(sec - 4 + i * 4))))];
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
  // Per video: every new placeholder's moment plus its strip of nearby frames, from one download.
  const byVideo = new Map<string, { markKey: string; sec: number }[]>();
  for (const [markKey, { videoId, sec }] of placeholderVideos(d)) {
    if (next[markKey] || !videoId || sec == null) continue;
    byVideo.set(videoId, [...(byVideo.get(videoId) ?? []), { markKey, sec }]);
  }
  let added = 0;
  for (const [videoId, marks] of byVideo) {
    if (!(await loadSource(videoId))) continue; // no archived video file to grab from
    const frames = await requestFramesAt(videoId, marks.flatMap((m) => [m.sec, ...screenshotWindowSecs(m.sec)]));
    const rows = await db.select().from(designFrames).where(inArray(designFrames.id, frames.map((f) => f.id)));
    for (const m of marks) {
      const row = rows.find((r) => Math.abs(Number(r.sec) - Math.round(m.sec * 100) / 100) < 0.01);
      if (!row) continue;
      next[m.markKey] = fromFrame(row, "auto");
      added++;
    }
  }
  if (added) await saveChosen(draftId, next);
  return added;
}

/** The picker's strip for one placeholder: frames across its moment (one download). */
export async function requestScreenshotWindow(draftId: string, markKey: string): Promise<DesignFrame[] | { error: string }> {
  const d = await loadDraft(draftId);
  if (!d) return { error: "Draft not found" };
  const mark = placeholderVideos(d).get(markKey);
  if (!mark?.videoId) return { error: "This section has no video to grab from. Upload an image instead." };
  if (mark.sec == null) return { error: "This placeholder has no moment in the video. Use the transcript to find one." };
  return requestFramesAt(mark.videoId, screenshotWindowSecs(mark.sec));
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
  /** Section key → its video id (images in any section get the scrubber and "Use the video thumbnail"). */
  sectionVideos: Record<string, string | null>;
  /** Video id → its YouTube thumbnail link. */
  thumbnails: Record<string, string>;
  /** Video id → its transcript, line by line with the second each line starts (for the picker). */
  transcripts: Record<string, { sec: number; text: string }[]>;
}

/** Everything the editor's screenshot panel needs. */
export async function listScreenshotFrames(draftId: string): Promise<ScreenshotState | null> {
  const d = await loadDraft(draftId);
  if (!d) return null;
  const chosen = await resolvePendingScreenshots(draftId, d.screenshots);
  const marks = Object.fromEntries([...placeholderVideos(d)].map(([k, v]) => [k, v.videoId]));
  const sectionVideos = Object.fromEntries(d.sections.map((s) => [s.key, sectionVideoId(d, s)]));
  const videoIds = [...new Set([...Object.values(marks), ...Object.values(sectionVideos)].filter((v): v is string => !!v))];
  const thumbnails: Record<string, string> = {};
  if (videoIds.length) {
    const rows = await db.select({ id: productionItems.id, youtubeId: productionItems.youtubeId }).from(productionItems).where(inArray(productionItems.id, videoIds));
    for (const r of rows) {
      const url = youtubeThumbnailUrl(r.youtubeId);
      if (url) thumbnails[r.id] = url;
    }
  }
  const frames: ScreenshotState["frames"] = [];
  const videoUrls: Record<string, string> = {};
  for (const videoId of videoIds) {
    const [{ frames: fs }, src] = await Promise.all([listFrames(videoId), loadSource(videoId)]);
    frames.push(...fs.filter((f) => f.origin === "user").map((f) => ({ ...f, videoId })));
    if (src) videoUrls[videoId] = await getPresignedGetUrl(src.key, 4 * 3600, { bucket: src.bucket ?? undefined });
  }
  frames.sort((a, b) => a.sec - b.sec);
  const transcripts: Record<string, { sec: number; text: string }[]> = {};
  for (const videoId of videoIds) {
    const t = await getTranscriptForPrompt(videoId);
    if (t?.segments?.length) transcripts[videoId] = t.segments.map((s) => ({ sec: s.startSec, text: s.text }));
  }
  return { frames, chosen, previews: await screenshotPreviewUrls(chosen), marks, videoUrls, sectionVideos, thumbnails, transcripts };
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

// ── "+ Add screenshot" on a step ────────────────────────────────────────
// The editor's + under a step with no image: Haiku reads the section video's
// timestamped transcript and the step, and says when the step happens on
// screen. The editor then places the placeholder and autoPickScreenshots
// grabs that frame + its strip. Paid but tiny (one Haiku call, ~$0.003).

const MOMENT_MODEL = "claude-haiku-5-5";
const MOMENT_TRANSCRIPT_CHARS = 40_000;

const MOMENT_TOOL: Anthropic.Tool = {
  name: "pick_moment",
  description: "Return the moment in the video where the step's action is on screen, and a short caption of what the screenshot shows.",
  input_schema: {
    type: "object" as const,
    properties: {
      timestamp: { type: "string", description: "M:SS (or H:MM:SS) a few seconds after the step's action starts on screen, from the transcript's timestamps." },
      label: { type: "string", description: "What the screenshot shows, 3 to 10 words, e.g. 'the voice list in Google AI Studio'." },
    },
    required: ["timestamp", "label"],
  },
};

export type StepMoment = { ok: true; sec: number; label: string } | { ok: false; failure: "no-video" | "no-transcript" | "llm-error" | "llm-empty" };

/** When `step` (its Markdown) happens in the section's video. Fail-soft: the editor adds a placeholder without a moment instead. */
export async function suggestStepMoment(draftId: string, sectionKey: string, step: string, client: Anthropic = new Anthropic()): Promise<StepMoment> {
  const d = await loadDraft(draftId);
  const videoId = d ? sectionVideoId(d, d.sections.find((x) => x.key === sectionKey)) : null;
  if (!videoId) return { ok: false, failure: "no-video" };
  const t = await getTranscriptForPrompt(videoId);
  if (!t?.segments?.length) return { ok: false, failure: "no-transcript" };
  const transcript = t.segments.map((x) => `[${formatTimestamp(x.startSec)}] ${x.text}`).join("\n").slice(0, MOMENT_TRANSCRIPT_CHARS);
  const last = t.segments[t.segments.length - 1].endSec ?? t.segments[t.segments.length - 1].startSec;
  let res: Anthropic.Message;
  try {
    res = await client.messages.create({
      model: MOMENT_MODEL,
      max_tokens: 200,
      system:
        "You place a screenshot for one step of a how-to newsletter written from a video. Find where in the video the step's action is shown on screen (not just mentioned in passing) and pick a moment a few seconds in, when the screen shows it. Always call pick_moment once.",
      tools: [MOMENT_TOOL],
      tool_choice: { type: "tool", name: "pick_moment" },
      messages: [{ role: "user", content: `The step:\n${step}\n\nThe video's transcript, timestamped:\n${transcript}` }],
    });
  } catch {
    return { ok: false, failure: "llm-error" };
  }
  const input = res.content.find((b) => b.type === "tool_use")?.input as { timestamp?: unknown; label?: unknown } | undefined;
  const ts = typeof input?.timestamp === "string" ? input.timestamp.trim() : "";
  const label = typeof input?.label === "string" ? input.label.replace(/[[\]*_]/g, "").trim().slice(0, 100) : "";
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(ts) || !label) return { ok: false, failure: "llm-empty" };
  return { ok: true, sec: Math.min(parseTimestamp(ts), Math.max(0, Math.floor(last))), label };
}
