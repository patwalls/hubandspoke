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

// SURFACE window when the operator gave an actual publish date
// (expectedPublishAt): flag into "Needs attention" one day after that date if
// we still haven't matched a go-live. Uniform across post types — the flag no
// longer stops matching (see MATCH_ABANDON_HOURS), so there's no reason to
// treat fast formats differently; a human just wants to know it's a day late.
const DATED_SURFACE_HOURS = 24;

// SURFACE window when there's NO publish date — whether the explicit "no
// publish date yet" no-date sweep, or a dated item whose expectedPublishAt is
// blank. `scheduled_at` is only the moment they clicked Scheduled, not a
// target, so give it more runway: flag 5 days after marked-Scheduled.
const NODATE_SURFACE_HOURS = 5 * 24;

// Absolute stop for the dated sweep. Past the surface window we only flag an
// item — we keep matching and re-syncing it, because posts routinely go live a
// few days after being marked Scheduled (batch-ahead planning) or slip past
// their expected date. Observed real slippage is 1–6 days; a dated post that
// still hasn't gone live a week later was almost certainly cancelled or
// mis-scheduled, and it's been surfaced in Needs-attention since day one, so a
// human owns it past here. Shorter than the no-date horizon on purpose: a
// dated item told us when to expect it.
const MATCH_ABANDON_HOURS = 7 * 24;

// Absolute stop for the no-date sweep — 14 days after marked Scheduled.
// Exported so the no-date sync selector (scheduled.ts) shares the same horizon.
export const NODATE_ABANDON_HOURS = 14 * 24;

export interface ReconcileSummary {
  considered: number;
  autoMerged: number;
  suggested: number;
  /** Items newly surfaced into "Needs attention" this pass (dated: 1 day past
   *  the scheduled date; no-date: 5 days past marked-Scheduled). They keep
   *  being matched afterwards, until MATCH_ABANDON_HOURS / NODATE_ABANDON_HOURS. */
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

    // Surface check: past the window with no confident match yet → flag it into
    // "Needs attention" for a human to eyeball, but DO NOT stop matching. The
    // window depends on whether the operator gave an actual publish date:
    //   - expectedPublishAt set → 1 day after that date;
    //   - no date (scheduledAt is just the click moment, not a target) → 5 days
    //     after marked-Scheduled, same as the explicit no-date sweep.
    // Matching continues every sweep until the abandon horizon in the query
    // above, so a late go-live is still auto-picked-up. This branch also
    // SELF-HEALS: if a flag was set under a stricter window (config change /
    // batch-ahead re-time), clear it once the item is back inside its window.
    const staleRef = row.expectedPublishAt ?? scheduledAt;
    const surfaceHours = row.expectedPublishAt
      ? DATED_SURFACE_HOURS
      : NODATE_SURFACE_HOURS;
    const ageHours = (now.getTime() - staleRef.getTime()) / (1000 * 60 * 60);
    const pastWindow = ageHours > surfaceHours;
    if (pastWindow && !row.scheduleNeedsAttentionAt) {
      await db
        .update(productionItems)
        .set({ scheduleNeedsAttentionAt: now, updatedAt: now })
        .where(eq(productionItems.id, row.id));
      row.scheduleNeedsAttentionAt = now;
      summary.gaveUp++;
    } else if (!pastWindow && row.scheduleNeedsAttentionAt) {
      await db
        .update(productionItems)
        .set({ scheduleNeedsAttentionAt: null, updatedAt: now })
        .where(eq(productionItems.id, row.id));
      row.scheduleNeedsAttentionAt = null;
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
 * Same flag-but-keep-matching shape as runScheduleReconcile(), but surfaces at
 * NODATE_SURFACE_HOURS (5 days) and abandons at NODATE_ABANDON_HOURS (14 days),
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

  const abandonCutoff = new Date(
    now.getTime() - NODATE_ABANDON_HOURS * 60 * 60 * 1000,
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
        eq(productionItems.scheduledNoDate, true),
        isNotNull(productionItems.scheduledAt),
        isNotNull(productionItems.accountId),
        isNull(productionItems.deletedAt),
        // Abandon horizon: keep matching flagged items until 14 days past
        // marked-Scheduled, then stop.
        gte(productionItems.scheduledAt, abandonCutoff),
        opts?.onlyItemIds && opts.onlyItemIds.length > 0
          ? inArray(productionItems.id, opts.onlyItemIds)
          : undefined,
      ),
    );

  for (const row of items) {
    summary.considered++;
    const scheduledAt = row.scheduledAt!;
    const accountId = row.accountId!;

    // Surface after 5 days with no confident match — flag it, but keep matching
    // (a late go-live still auto-picks-up until the abandon horizon above).
    const ageHours = (now.getTime() - scheduledAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > NODATE_SURFACE_HOURS && !row.scheduleNeedsAttentionAt) {
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
      // Now that a candidate is awaiting a human, lift it out of
      // Needs-attention into Suggestions.
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
