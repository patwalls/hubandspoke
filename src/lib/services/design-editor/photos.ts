/**
 * A source video's extra picture library (`design_photos`, keyed by the
 * PILLAR like the filmstrip): photos of the founder the team uploads, the
 * cutouts the browser makes (background removed), and the dashboard /
 * revenue screens the `design-screens` job finds in the video. Every post
 * made from the video sees the same library, so a photo uploaded for one
 * carousel is there for the next.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { imageSize } from "image-size";
import { db } from "@/lib/db";
import { designPhotos } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { bucketName, buildKey, deleteObject, getPresignedGetUrl, putObject } from "@/lib/s3";
import type { DesignImageSource } from "@/lib/design-editor/doc";
import { imageSourceKey } from "@/lib/editor/image-source";
import type { ImageCandidate } from "@/lib/design-editor/brand-assets";

export type DesignPhotoKind = "upload" | "cutout" | "screen";

export interface DesignPhoto extends ImageCandidate {
  id: string;
  kind: DesignPhotoKind;
  width: number | null;
  height: number | null;
  /** cutout: `imageSourceKey` of the picture it was cut from. */
  sourceKey: string | null;
  /** screen: seconds into the video. */
  sec: number | null;
  /** screen: 1 = the AI's best. */
  rank: number | null;
}

export interface DesignPhotosState {
  photos: DesignPhoto[];
  /** The screen scan is queued or running. */
  screensPending: boolean;
}

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);

export class DesignPhotoUploadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "DesignPhotoUploadError";
  }
}

export function screensJobKey(sourceItemId: string): string {
  return `design-screens:${sourceItemId}`;
}

export async function listPhotos(sourceItemId: string): Promise<DesignPhotosState> {
  const rows = await db
    .select()
    .from(designPhotos)
    .where(eq(designPhotos.productionItemId, sourceItemId))
    .orderBy(sql`${designPhotos.rank} NULLS LAST`, desc(designPhotos.createdAt), asc(designPhotos.sec));
  return { photos: await Promise.all(rows.map(toPhoto)), screensPending: await screensPending(sourceItemId) };
}

/** The founder photo the team uploaded for this video, if any — the first
 *  one uploaded (the one the upload put on the page). Real photos of the
 *  founder beat any still of the video, so the cover prefers this. */
export async function founderPhotoFor(sourceItemId: string): Promise<DesignImageSource | null> {
  const [row] = await db
    .select({ s3Bucket: designPhotos.s3Bucket, s3Key: designPhotos.s3Key })
    .from(designPhotos)
    .where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "upload")))
    .orderBy(asc(designPhotos.createdAt))
    .limit(1);
  return row ? { kind: "s3", bucket: row.s3Bucket, key: row.s3Key } : null;
}

/** The cutout made from this picture, if there is one. */
export async function cutoutFor(sourceItemId: string, source: DesignImageSource): Promise<DesignPhoto | null> {
  const [row] = await db
    .select()
    .from(designPhotos)
    .where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "cutout"), eq(designPhotos.sourceKey, imageSourceKey(source))))
    .orderBy(desc(designPhotos.createdAt))
    .limit(1);
  return row ? toPhoto(row) : null;
}

/** Store an uploaded picture (or a cutout the browser made) in the library. */
export async function addPhoto(args: { sourceItemId: string; file: File; kind: "upload" | "cutout"; cutoutOf?: DesignImageSource | null; userId: string | null }): Promise<DesignPhoto> {
  const { file } = args;
  if (!ALLOWED.has(file.type)) throw new DesignPhotoUploadError("Use a JPG, PNG or WebP", 415);
  if (file.size > MAX_BYTES) throw new DesignPhotoUploadError("Image is over 15 MB", 413);
  const buf = Buffer.from(await file.arrayBuffer());
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(buf);
  } catch {
    throw new DesignPhotoUploadError("That file isn't a readable image", 415);
  }
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const base = (file.name || (args.kind === "cutout" ? "cutout" : "photo")).replace(/\.[^.]+$/, "");
  const safe = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || args.kind;
  const key = buildKey(args.sourceItemId, `design-${args.kind}-${safe}.${ext}`);
  await putObject(key, buf, file.type);
  const sourceKey = args.kind === "cutout" && args.cutoutOf ? imageSourceKey(args.cutoutOf) : null;
  // One cutout per picture: a redo replaces the old row (its object stays —
  // a document may still reference it).
  if (sourceKey) await db.delete(designPhotos).where(and(eq(designPhotos.productionItemId, args.sourceItemId), eq(designPhotos.kind, "cutout"), eq(designPhotos.sourceKey, sourceKey)));
  const [row] = await db
    .insert(designPhotos)
    .values({ productionItemId: args.sourceItemId, kind: args.kind, label: args.kind === "cutout" ? `Cutout · ${base}` : base, s3Bucket: bucketName(), s3Key: key, width: dims.width ?? null, height: dims.height ?? null, sourceKey, createdByUserId: args.userId })
    .returning();
  return toPhoto(row);
}

/** Remove a picture from the library (and its object). Documents that
 *  already placed it keep their copy of the source and will fail to render
 *  it — the editor only offers delete for library entries. */
export async function deletePhoto(sourceItemId: string, photoId: string): Promise<boolean> {
  const [row] = await db.delete(designPhotos).where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.id, photoId))).returning();
  if (!row) return false;
  await deleteObject(row.s3Key).catch(() => {});
  return true;
}

/** Ask the worker to scan the video for dashboard / revenue screens. No-op
 *  when screens already exist unless `force`. */
export async function requestScreens(sourceItemId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const [existing] = await db.select({ id: designPhotos.id }).from(designPhotos).where(and(eq(designPhotos.productionItemId, sourceItemId), eq(designPhotos.kind, "screen"))).limit(1);
    if (existing) return;
  }
  await enqueue("design-screens", { sourceItemId }, { jobKey: screensJobKey(sourceItemId), jobKeyMode: "preserve_run_at", queueName: "media-heavy", maxAttempts: 2 });
}

export async function screensPending(sourceItemId: string): Promise<boolean> {
  const queued = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = ${screensJobKey(sourceItemId)}`);
  return ((queued as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0;
}

async function toPhoto(row: typeof designPhotos.$inferSelect): Promise<DesignPhoto> {
  const src: DesignImageSource = { kind: "s3", bucket: row.s3Bucket, key: row.s3Key };
  return {
    id: row.id,
    kind: row.kind as DesignPhotoKind,
    label: row.label,
    src,
    previewUrl: await getPresignedGetUrl(row.s3Key, 4 * 3600, { bucket: row.s3Bucket }),
    width: row.width,
    height: row.height,
    sourceKey: row.sourceKey,
    sec: row.sec === null ? null : Number(row.sec),
    rank: row.rank,
  };
}
