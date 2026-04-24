import type { Task } from "graphile-worker";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, viewSnapshots } from "@/lib/db/schema";
import { refreshItemMetrics } from "@/lib/services/performance-decay";

// Sub-hourly metrics sweep for items in their first few days. The existing
// `performance-decay` cron (hourly) keeps the cumulative `views/likes/
// comments` on `productionItems` fresh; this cron additionally writes a row
// to `view_snapshots` on every pass so the cross-post scanner can compute
// velocity (views at ~1h, vs the account+postType baseline). Only sweeps
// young items — older ones don't need high-frequency snapshots.
const FRESH_WINDOW_HOURS = 72;
// Safety cap so a badly-misconfigured cron can't runaway-bill SC. At default
// volume we expect ~50 fresh items per sweep.
const MAX_ITEMS_PER_SWEEP = 200;

export const freshMetricsSyncTask: Task = async (_payload, helpers) => {
  const start = Date.now();

  // Candidate pool: published items published within the fresh window that
  // have a publish timestamp we can anchor the snapshot age to.
  const candidates = await db
    .select({
      id: productionItems.id,
      publishedAt: productionItems.publishedAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Published"),
        eq(productionItems.sourceType, "original"),
        isNotNull(productionItems.publishedAt),
        gte(
          productionItems.publishedAt,
          sql`(now() - interval '${sql.raw(String(FRESH_WINDOW_HOURS))} hours')`
        )
      )
    )
    .limit(MAX_ITEMS_PER_SWEEP);

  helpers.logger.info(
    `fresh-metrics-sync candidates=${candidates.length} window_h=${FRESH_WINDOW_HOURS}`
  );

  let refreshed = 0;
  let snapshotted = 0;
  let creditsUsed = 0;
  const errors: string[] = [];

  for (const c of candidates) {
    if (!c.publishedAt) continue;
    try {
      const r = await refreshItemMetrics(c.id);
      creditsUsed += r.creditsUsed;
      if (!r.updated) {
        if (r.note) errors.push(`${c.id} (${r.platform}): ${r.note}`);
        continue;
      }
      refreshed++;

      if (r.views == null) {
        // Platforms where SC didn't return any view signal (e.g. LinkedIn
        // without likes→estimate path). Skip the snapshot — views is NOT
        // NULL on view_snapshots and we don't want zeros polluting the
        // velocity median.
        continue;
      }

      const ageMs = Date.now() - new Date(c.publishedAt).getTime();
      const postAgeMinutes = Math.max(0, Math.floor(ageMs / 60_000));

      await db.insert(viewSnapshots).values({
        productionItemId: c.id,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
        postAgeMinutes,
      });
      snapshotted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${c.id}: ${msg}`);
    }
  }

  helpers.logger.info(
    `fresh-metrics-sync done refreshed=${refreshed} snapshots=${snapshotted} credits=${creditsUsed} errors=${errors.length} (${Date.now() - start}ms)`
  );

  if (errors.length > 0) {
    helpers.logger.warn(
      `fresh-metrics-sync first-errors: ${errors.slice(0, 5).join("; ")}`
    );
  }
};
