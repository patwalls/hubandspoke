/**
 * A source video's photo library: still frames of the founder, shared by
 * every post made from the video (keyed by the SOURCE item).
 *
 * The first open of a design asks the worker for a filmstrip (`auto`: ~12
 * frames sampled where the guest talks, then Haiku ranks the best shots —
 * rank 1 is the cover); the editor can also grab a frame at an exact moment
 * (`user`). Rows live in `design_frames`; the worker task is
 * src/jobs/tasks/design-frames.ts.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designFrames } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import type { DesignImageSource } from "@/lib/design-editor/doc";
import { getPresignedGetUrl } from "@/lib/s3";

export const AUTO_FRAME_COUNT = 12;
export const FRAME_WIDTH = 1080;

export interface DesignFrame {
  id: string;
  sec: number;
  status: "pending" | "done" | "failed";
  origin: "auto" | "user";
  isPick: boolean;
  /** 1 = the cover pick, 2–3 the runner-up shots, null otherwise. */
  rank: number | null;
  src: DesignImageSource | null;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
}

export { storyFrames } from "@/lib/design-editor/story-frames";

export interface DesignFramesState {
  frames: DesignFrame[];
  /** Something is still being extracted (rows pending, or the auto job is
   *  queued and hasn't inserted its rows yet). */
  pending: boolean;
}

export function autoFramesJobKey(sourceItemId: string): string {
  return `design-frames:auto:${sourceItemId}`;
}

/** Ask for the video's filmstrip once. Idempotent: no-op when frames
 *  already exist or the job is already queued. `force` re-runs it (a
 *  failed first attempt, or a transcript that arrived since). */
export async function requestAutoFrames(sourceItemId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force) {
    const [existing] = await db.select({ id: designFrames.id }).from(designFrames).where(and(eq(designFrames.productionItemId, sourceItemId), eq(designFrames.origin, "auto"))).limit(1);
    if (existing) return;
  }
  await enqueue(
    "design-frames",
    { sourceItemId },
    { jobKey: autoFramesJobKey(sourceItemId), jobKeyMode: "preserve_run_at", queueName: "media-heavy", maxAttempts: 2 },
  );
}

/** Grab one frame at `sec` (the editor's "use this frame"). */
export async function requestFrameAt(sourceItemId: string, sec: number): Promise<DesignFrame> {
  const rounded = Math.max(0, Math.round(sec * 100) / 100);
  const [row] = await db
    .insert(designFrames)
    .values({ productionItemId: sourceItemId, sec: rounded.toFixed(2), origin: "user", status: "pending" })
    .onConflictDoUpdate({ target: [designFrames.productionItemId, designFrames.sec], set: { updatedAt: new Date() } })
    .returning();
  if (row.status !== "done") {
    await enqueue(
      "design-frames",
      { sourceItemId, atSec: rounded },
      { jobKey: `design-frames:at:${sourceItemId}:${rounded.toFixed(2)}`, jobKeyMode: "preserve_run_at", queueName: "media-heavy", maxAttempts: 2 },
    );
  }
  return toFrame(row);
}

export async function listFrames(sourceItemId: string): Promise<DesignFramesState> {
  const rows = await db.select().from(designFrames).where(eq(designFrames.productionItemId, sourceItemId)).orderBy(asc(designFrames.sec));
  const frames = (await Promise.all(rows.map(toFrame))).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.sec - b.sec);
  let pending = frames.some((f) => f.status === "pending");
  // The auto filmstrip isn't finished until the AI has picked: the rows go
  // `done` one by one and `is_pick` is written last, so "no pending rows"
  // alone would stop the editor polling a few seconds too early.
  const auto = frames.filter((f) => f.origin === "auto");
  const autoUnpicked = auto.length > 0 && auto.every((f) => f.status !== "pending") && !auto.some((f) => f.isPick) && auto.some((f) => f.status === "done");
  if (!pending && (frames.length === 0 || autoUnpicked)) {
    // Still queued/running (the job inserts its rows and picks at the end)?
    const queued = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE key = ${autoFramesJobKey(sourceItemId)}`,
    );
    pending = ((queued as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0;
  }
  return { frames, pending };
}

export async function pickedFrame(sourceItemId: string): Promise<DesignFrame | null> {
  const [row] = await db
    .select()
    .from(designFrames)
    .where(and(eq(designFrames.productionItemId, sourceItemId), eq(designFrames.isPick, true), eq(designFrames.status, "done")))
    .limit(1);
  return row ? toFrame(row) : null;
}

async function toFrame(row: typeof designFrames.$inferSelect): Promise<DesignFrame> {
  const src: DesignImageSource | null = row.status === "done" && row.s3Key ? { kind: "s3", bucket: row.s3Bucket, key: row.s3Key } : null;
  return {
    id: row.id,
    sec: Number(row.sec),
    status: row.status as DesignFrame["status"],
    origin: row.origin as DesignFrame["origin"],
    isPick: row.isPick,
    rank: row.rank,
    src,
    previewUrl: src ? await getPresignedGetUrl(src.key, 4 * 3600, { bucket: src.bucket ?? undefined }) : null,
    width: row.width,
    height: row.height,
  };
}
