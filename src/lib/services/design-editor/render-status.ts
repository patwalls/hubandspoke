import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { designRenders } from "@/lib/db/schema";

/** Same derived-state contract as the clip editor's render-status.ts. */
const STALL_MS = 5 * 60 * 1000;
const QUEUE_STALL_MS = 20 * 60 * 1000;

export type DesignRenderState = "queued" | "rendering" | "done" | "failed" | "stalled" | "superseded";

export interface DesignRenderStatus {
  id: string;
  designDocId: string;
  productionItemId: string;
  state: DesignRenderState;
  progress: number;
  error: string | null;
  pageCount: number | null;
  createdAt: string;
  finishedAt: string | null;
}

export function toDesignRenderStatus(row: typeof designRenders.$inferSelect, now = Date.now()): DesignRenderStatus {
  let state = row.status as DesignRenderState;
  if (state === "rendering") {
    const beat = (row.heartbeatAt ?? row.startedAt ?? row.createdAt).getTime();
    if (now - beat > STALL_MS) state = "stalled";
  } else if (state === "queued" && now - row.createdAt.getTime() > QUEUE_STALL_MS) {
    state = "stalled";
  }
  return {
    id: row.id,
    designDocId: row.designDocId,
    productionItemId: row.productionItemId,
    state,
    progress: row.progress,
    error: row.error,
    pageCount: row.outputKeys?.length ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export async function getLatestDesignRenderForItem(productionItemId: string): Promise<DesignRenderStatus | null> {
  const [row] = await db
    .select()
    .from(designRenders)
    .where(eq(designRenders.productionItemId, productionItemId))
    .orderBy(desc(designRenders.createdAt))
    .limit(1);
  return row ? toDesignRenderStatus(row) : null;
}
