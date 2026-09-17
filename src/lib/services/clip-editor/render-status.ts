/**
 * Read model for a clip render — what the editor and the content-detail pill
 * poll. `stalled` is derived, never stored: a render whose worker died
 * without throwing keeps status="rendering" in the DB, and only a stale
 * heartbeat reveals it.
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipRenders } from "@/lib/db/schema";

/** No heartbeat for this long while "rendering" = the worker is gone. ffmpeg
 *  progress ticks every few seconds, so minutes of silence is never normal. */
export const RENDER_STALL_MS = 5 * 60 * 1000;
/** A queued render the worker hasn't picked up in this long is stuck too
 *  (worker down, or the media-heavy queue is wedged). */
export const RENDER_QUEUE_STALL_MS = 20 * 60 * 1000;

export type ClipRenderState =
  | "queued"
  | "rendering"
  | "done"
  | "failed"
  | "stalled"
  | "superseded";

export interface ClipRenderStatus {
  id: string;
  clipEditId: string;
  productionItemId: string;
  state: ClipRenderState;
  progress: number;
  error: string | null;
  durationSec: number | null;
  renderSeconds: number | null;
  createdAt: string;
  finishedAt: string | null;
}

type RenderRow = typeof clipRenders.$inferSelect;

export function toRenderStatus(row: RenderRow, now = Date.now()): ClipRenderStatus {
  let state = row.status as ClipRenderState;
  if (state === "rendering") {
    const beat = (row.heartbeatAt ?? row.startedAt ?? row.createdAt).getTime();
    if (now - beat > RENDER_STALL_MS) state = "stalled";
  } else if (state === "queued") {
    if (now - row.createdAt.getTime() > RENDER_QUEUE_STALL_MS) state = "stalled";
  }
  return {
    id: row.id,
    clipEditId: row.clipEditId,
    productionItemId: row.productionItemId,
    state,
    progress: row.progress,
    error: row.error,
    durationSec: row.durationSec ? Number(row.durationSec) : null,
    renderSeconds: row.renderSeconds ? Number(row.renderSeconds) : null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export async function getLatestClipRenderForItem(
  productionItemId: string,
): Promise<ClipRenderStatus | null> {
  const [row] = await db
    .select()
    .from(clipRenders)
    .where(eq(clipRenders.productionItemId, productionItemId))
    .orderBy(desc(clipRenders.createdAt))
    .limit(1);
  return row ? toRenderStatus(row) : null;
}
