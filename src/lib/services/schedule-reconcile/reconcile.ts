// Orchestrator for the schedule-reconcile sweep. Walks every pending
// Scheduled item, asks the matcher whether a newly-synced Published post is
// that post going live, and applies the tier policy:
//   - score >= AUTO_MATCH_SCORE → auto-merge (Scheduled item becomes the
//     published row, the synced duplicate is absorbed)
//   - SUGGEST_SCORE..AUTO-1     → upsert a pending suggestion for a human
//   - below SUGGEST_SCORE       → leave Scheduled, retry next sweep
//   - aged past its per-post-type window with no match → flag needs-attention
//     (surface it for a human) but KEEP matching and re-syncing — posts slip
//     past their date or are scheduled days ahead, so a late go-live must still
//     auto-pick-up. "Needs attention" means "not matched yet", not "abandoned".
//   - aged past MATCH_ABANDON_HOURS with no match → stop matching entirely
//     (assume it was cancelled / will never publish)

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems, scheduledMatchSuggestions } from "@/lib/db/schema";
import {
  findBestScheduledMatch,
  type ScheduledItemForMatch,
} from "./matcher";
import { reconcileScheduledIntoPublished } from "@/lib/services/merge-production-items";

// Confidence tiers (0–100). ≥85 auto-applies; 55–84 waits for a human.
export const AUTO_MATCH_SCORE = 85;
export const SUGGEST_SCORE = 55;

// Once a pending item's expected publish time has arrived, only re-sync its
// account this often via the targeted-freshness job — no point spending an
// SC credit every 10-min tick for a post that isn't due for days.
export const SCHEDULE_SYNC_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Accounts that should get a fresh `account-content-sync` this tick because
 * they own a pending Scheduled item that's either due (no expected date, or
 * its expected date has arrived) — and, for dated items, haven't already
 * been synced within `SCHEDULE_SYNC_THROTTLE_MS`. An item with an
 * `expectedPublishAt` days out is skipped entirely until that time arrives;
 * an item with no expected date (can't tell when to expect it) keeps the
 * original every-tick behavior.
 */
export async function selectAccountsForScheduleSync(
  now: Date = new Date(),
): Promise<string[]> {
  const throttleCutoff = new Date(now.getTime() - SCHEDULE_SYNC_THROTTLE_MS);
  const abandonCutoff = new Date(
    now.getTime() - MATCH_ABANDON_HOURS * 60 * 60 * 1000,
  );

  const rows = await db
    .selectDistinct({ accountId: productionItems.accountId })
    .from(productionItems)
    .innerJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(
      and(
        eq(productionItems.status, "Scheduled"),
        isNotNull(productionItems.accountId),
        isNull(productionItems.deletedAt),
        // Keep re-syncing an account even for items already flagged
        // "needs attention" — a late or slipped go-live must still be
        // detectable. Only drop an item once it's clearly never coming
        // (past the abandon horizon, measured from expected go-live when
        // known, else the scheduled-at). Date-less items never abandon on time.
        or(
          and(
            isNotNull(productionItems.expectedPublishAt),
            gte(productionItems.expectedPublishAt, abandonCutoff),
          ),
          and(
            isNull(productionItems.expectedPublishAt),
            isNotNull(productionItems.scheduledAt),
            gte(productionItems.scheduledAt, abandonCutoff),
          ),
          and(
            isNull(productionItems.expectedPublishAt),
            isNull(productionItems.scheduledAt),
          ),
        ),
        or(
          isNull(productionItems.expectedPublishAt),
          and(
            lte(productionItems.expectedPublishAt, now),
            or(
              isNull(accounts.lastContentSyncAt),
              lte(accounts.lastContentSyncAt, throttleCutoff),
            ),
          ),
        ),
      ),
    );

  return rows
    .map((r) => r.accountId)
    .filter((id): id is string => id != null);
}

// Per-post-type SURFACE window, in hours: how long a dated item may sit at
// Scheduled with no confident match before we flag it into "Needs attention"
// for a human to eyeball. This NO LONGER stops matching (see
// MATCH_ABANDON_HOURS) — a flagged item keeps being matched and re-synced so a
// late go-live still gets picked up automatically. Fast-moving short-form
// surfaces after a day; slower formats get a longer ceiling. Modeled on the
// per-platform age-gate maps in repost-candidates.ts.
const STALE_WINDOW_HOURS = { fast: 24, default: 48 } as const;
const FAST_POST_TYPES = new Set(["x", "tiktok", "threads"]);

// No-date items have no expected go-live; 14 days gives ample runway before
// flagging them as needing attention.
const NODATE_STALE_WINDOW_HOURS = 14 * 24;

// Absolute stop for the dated sweep. Past the per-type surface window we only
// flag an item (above) — we keep matching and re-syncing it, because posts
// routinely go live a few days after being marked Scheduled (batch-ahead
// planning) or slip past their expected date. Observed real slippage is 1–6
// days; a dated post that still hasn't gone live a week later was almost
// certainly cancelled or mis-scheduled, and it's been surfaced in
// Needs-attention since 24–48h, so a human owns it past here. Shorter than the
// no-date horizon on purpose: a dated item told us when to expect it.
const MATCH_ABANDON_HOURS = 7 * 24;

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
  /** Items newly surfaced into "Needs attention" this pass. Dated sweep: past
   *  their per-type surface window (still matched afterwards until
   *  MATCH_ABANDON_HOURS). No-date sweep: past the 14-day horizon (a true
   *  give-up). */
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

  const abandonCutoff = new Date(
    now.getTime() - MATCH_ABANDON_HOURS * 60 * 60 * 1000,
  );

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
      scheduleNeedsAttentionAt: productionItems.scheduleNeedsAttentionAt,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.status, "Scheduled"),
        isNotNull(productionItems.scheduledAt),
        isNotNull(productionItems.accountId),
        isNull(productionItems.deletedAt),
        // No-date items are handled by the separate hourly schedule-nodate-sweep.
        or(
          isNull(productionItems.scheduledNoDate),
          eq(productionItems.scheduledNoDate, false),
        ),
        // Abandon horizon: keep matching flagged ("needs attention") items —
        // a late/slipped/batch-ahead go-live must still auto-pick-up — until
        // the item is clearly never coming, then stop. Measured from expected
        // go-live when known, else scheduled-at (which is non-null here).
        or(
          and(
            isNotNull(productionItems.expectedPublishAt),
            gte(productionItems.expectedPublishAt, abandonCutoff),
          ),
          and(
            isNull(productionItems.expectedPublishAt),
            gte(productionItems.scheduledAt, abandonCutoff),
          ),
        ),
        opts?.onlyItemIds && opts.onlyItemIds.length > 0
          ? inArray(productionItems.id, opts.onlyItemIds)
          : undefined,
      ),
    );

  for (const row of items) {
    summary.considered++;
    const scheduledAt = row.scheduledAt!;
    const accountId = row.accountId!;

    // Surface check: past the per-post-type window with no confident match yet.
    // Flag it into "Needs attention" for a human to eyeball — but DO NOT stop
    // matching. The reference is the operator's expected go-live when they gave
    // one (scheduledAt alone is just when they clicked "Scheduled", often days
    // before the post actually publishes for batch-ahead scheduling). Matching
    // continues every sweep until the abandon horizon in the query above, so a
    // late go-live is still auto-picked-up.
    const staleRef = row.expectedPublishAt ?? scheduledAt;
    const ageHours = (now.getTime() - staleRef.getTime()) / (1000 * 60 * 60);
    if (
      ageHours > staleWindowHours(row.postType) &&
      !row.scheduleNeedsAttentionAt
    ) {
      await db
        .update(productionItems)
        .set({ scheduleNeedsAttentionAt: now, updatedAt: now })
        .where(eq(productionItems.id, row.id));
      row.scheduleNeedsAttentionAt = now;
      summary.gaveUp++;
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
      // We now have a candidate for a human to confirm — it's no longer "we
      // found nothing", so lift it out of Needs-attention into Suggestions.
      if (row.scheduleNeedsAttentionAt) {
        await db
          .update(productionItems)
          .set({ scheduleNeedsAttentionAt: null, updatedAt: now })
          .where(eq(productionItems.id, row.id));
        row.scheduleNeedsAttentionAt = null;
      }
      summary.suggested++;
    } else {
      summary.skipped++;
    }
  }

  return summary;
}

/**
 * Run one reconcile pass over pending "no publish date yet" Scheduled items.
 * Identical logic to runScheduleReconcile() but uses a 14-day give-up window
 * and only processes items where scheduledNoDate = true. Called by the hourly
 * schedule-nodate-sweep cron task.
 */
export async function runScheduleNodateReconcile(opts?: {
  now?: Date;
  client?: Anthropic;
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
        eq(productionItems.scheduledNoDate, true),
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

    const ageHours = (now.getTime() - scheduledAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > NODATE_STALE_WINDOW_HOURS) {
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
