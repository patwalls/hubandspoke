// Orchestrator for the schedule-reconcile sweep. Walks every pending
// Scheduled item, asks the matcher whether a newly-synced Published post is
// that post going live, and applies the tier policy:
//   - score >= AUTO_MATCH_SCORE → auto-merge (Scheduled item becomes the
//     published row, the synced duplicate is absorbed)
//   - SUGGEST_SCORE..AUTO-1     → upsert a pending suggestion for a human
//   - below SUGGEST_SCORE       → leave Scheduled, retry next sweep
//   - aged past its per-post-type window with no match → flag needs-attention
//     and stop matching it (some content must never sit at Scheduled past 24h)

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";
import {
  findBestScheduledMatch,
  type ScheduledItemForMatch,
} from "./matcher";
import { reconcileScheduledIntoPublished } from "@/lib/services/merge-production-items";

// Confidence tiers (0–100). ≥85 auto-applies; 55–84 waits for a human.
export const AUTO_MATCH_SCORE = 85;
export const SUGGEST_SCORE = 55;

// Per-post-type give-up window, in hours. Fast-moving short-form should never
// sit at Scheduled for more than a day; slower formats get a longer ceiling.
// Modeled on the per-platform age-gate maps in repost-candidates.ts.
const STALE_WINDOW_HOURS = { fast: 24, default: 48 } as const;
const FAST_POST_TYPES = new Set(["x", "tiktok", "threads"]);

export function staleWindowHours(postType: string | null): number {
  if (!postType) return STALE_WINDOW_HOURS.default;
  if (FAST_POST_TYPES.has(postType)) return STALE_WINDOW_HOURS.fast;
  // instagram_reel / instagram_post / instagram_story are all fast.
  if (postType.startsWith("instagram")) return STALE_WINDOW_HOURS.fast;
  return STALE_WINDOW_HOURS.default;
}

export interface ReconcileSummary {
  considered: number;
  autoMerged: number;
  suggested: number;
  gaveUp: number;
  llmErrors: number;
  skipped: number;
}

/**
 * Run one reconcile pass over all pending Scheduled items. Pure of any
 * platform fetching — it matches against whatever Published rows already
 * exist (the sweep separately keeps those fresh). Safe to run repeatedly.
 */
export async function runScheduleReconcile(opts?: {
  now?: Date;
  client?: Anthropic;
  /** Restrict the scan to specific Scheduled item ids. Used by tests to
   *  isolate from other pending items in a shared dev DB; could also scope a
   *  targeted re-run. */
  onlyItemIds?: string[];
}): Promise<ReconcileSummary> {
  const now = opts?.now ?? new Date();
  const summary: ReconcileSummary = {
    considered: 0,
    autoMerged: 0,
    suggested: 0,
    gaveUp: 0,
    llmErrors: 0,
    skipped: 0,
  };

  const items = await db
    .select({
      id: productionItems.id,
      accountId: productionItems.accountId,
      postType: productionItems.postType,
      title: productionItems.title,
      hook: productionItems.hook,
      contentBody: productionItems.contentBody,
      scheduledAt: productionItems.scheduledAt,
      expectedPublishAt: productionItems.expectedPublishAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Scheduled"),
        isNotNull(productionItems.scheduledAt),
        isNull(productionItems.scheduleNeedsAttentionAt),
        isNotNull(productionItems.accountId),
        isNull(productionItems.deletedAt),
        opts?.onlyItemIds && opts.onlyItemIds.length > 0
          ? inArray(productionItems.id, opts.onlyItemIds)
          : undefined,
      ),
    );

  for (const row of items) {
    summary.considered++;
    const scheduledAt = row.scheduledAt!;
    const accountId = row.accountId!;

    // Give-up check: past the per-post-type window with no confident match.
    const ageHours = (now.getTime() - scheduledAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > staleWindowHours(row.postType)) {
      await db
        .update(productionItems)
        .set({ scheduleNeedsAttentionAt: now, updatedAt: now })
        .where(eq(productionItems.id, row.id));
      summary.gaveUp++;
      continue;
    }

    const item: ScheduledItemForMatch = {
      id: row.id,
      accountId,
      postType: row.postType,
      title: row.title,
      hook: row.hook,
      contentBody: row.contentBody,
      scheduledAt,
      expectedPublishAt: row.expectedPublishAt,
    };

    const result = await findBestScheduledMatch(item, { client: opts?.client });
    if (!result.ok) {
      // LLM error — treat as no-match this tick, retry next sweep.
      summary.llmErrors++;
      continue;
    }
    if (!result.value) {
      summary.skipped++;
      continue;
    }

    const { candidateId, score, reason } = result.value;

    if (score >= AUTO_MATCH_SCORE) {
      const merged = await reconcileScheduledIntoPublished(
        row.id,
        candidateId,
        null,
      );
      if (merged.success) {
        summary.autoMerged++;
        // Any pending suggestions for this now-published item are moot.
        await db
          .update(scheduledMatchSuggestions)
          .set({ status: "superseded", resolvedAt: now, updatedAt: now })
          .where(
            and(
              eq(scheduledMatchSuggestions.scheduledItemId, row.id),
              eq(scheduledMatchSuggestions.status, "pending"),
            ),
          );
      } else {
        // Merge failed (e.g. cross-account guard) — leave Scheduled.
        summary.skipped++;
      }
    } else if (score >= SUGGEST_SCORE) {
      await db
        .insert(scheduledMatchSuggestions)
        .values({
          scheduledItemId: row.id,
          candidateItemId: candidateId,
          score,
          reason,
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [
            scheduledMatchSuggestions.scheduledItemId,
            scheduledMatchSuggestions.candidateItemId,
          ],
          set: { score, reason, status: "pending", updatedAt: now },
        });
      summary.suggested++;
    } else {
      summary.skipped++;
    }
  }

  return summary;
}
