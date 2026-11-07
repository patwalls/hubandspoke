/**
 * Which clip ideas a video's Clip Ideas panel shows: the newest batch of
 * EACH format. Generation runs one batch per (video, format), so "the newest
 * batch" alone showed only the last format generated — a video with Reels,
 * X Quotables and Tech Stack ideas listed just one of them (fixed 2026-11-07).
 * Ideas from before formats were tracked (target_format null) count as one
 * format of their own.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export async function latestClipIdeaBatches(
  pillarId: string,
): Promise<{ batchIds: string[]; createdAt: Date | null }> {
  const res = await db.execute(sql`
    SELECT DISTINCT ON (coalesce(target_format, '')) batch_id, created_at
    FROM clip_ideas
    WHERE source_production_item_id = ${pillarId}
    ORDER BY coalesce(target_format, ''), created_at DESC
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Array<{ batch_id: string; created_at: Date | string }>;
  if (rows.length === 0) return { batchIds: [], createdAt: null };
  const times = rows.map((r) => new Date(r.created_at));
  return {
    batchIds: rows.map((r) => r.batch_id),
    createdAt: new Date(Math.max(...times.map((t) => t.getTime()))),
  };
}
