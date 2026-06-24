import { db } from "@/lib/db";
import {
  productionItems,
  contentComments,
  contentEvents,
} from "@/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";
import { scheduleVelocitySnapshots } from "@/jobs/tasks/capture-velocity-snapshot";

export interface MergeResult {
  success: boolean;
  message: string;
  primaryId: string;
  secondaryId: string;
  deletedId: string;
}

/**
 * Determine which item should be kept (keeper).
 * The keeper is the one with more "ownership" signals:
 * - Has comments (edited by team)
 * - Created earlier (likely the original, API pulled duplicate later)
 * - Has editor email/name (explicitly assigned)
 */
async function determineKeeper(
  itemA: typeof productionItems.$inferSelect,
  itemB: typeof productionItems.$inferSelect
): Promise<{ keeper: typeof productionItems.$inferSelect; duplicate: typeof productionItems.$inferSelect }> {
  // Count comments for each item
  const [commentsA, commentsB] = await Promise.all([
    db
      .select({ count: count() })
      .from(contentComments)
      .where(eq(contentComments.contentItemId, itemA.id)),
    db
      .select({ count: count() })
      .from(contentComments)
      .where(eq(contentComments.contentItemId, itemB.id)),
  ]);

  const countA = commentsA[0]?.count || 0;
  const countB = commentsB[0]?.count || 0;

  // Keeper signals (in priority order):
  // 1. Has comments (indicates editorial work)
  if (countA > countB) return { keeper: itemA, duplicate: itemB };
  if (countB > countA) return { keeper: itemB, duplicate: itemA };

  // 2. Has editor metadata (explicitly assigned)
  const itemAHasEditor = itemA.editorEmail || itemA.editorName;
  const itemBHasEditor = itemB.editorEmail || itemB.editorName;
  if (itemAHasEditor && !itemBHasEditor) return { keeper: itemA, duplicate: itemB };
  if (itemBHasEditor && !itemAHasEditor) return { keeper: itemB, duplicate: itemA };

  // 3. Created earlier (likely the original)
  if (itemA.createdAt < itemB.createdAt) return { keeper: itemA, duplicate: itemB };
  if (itemB.createdAt < itemA.createdAt) return { keeper: itemB, duplicate: itemA };

  // Fallback: keep the first one
  return { keeper: itemA, duplicate: itemB };
}

/**
 * Merge two duplicate production items.
 *
 * This function performs a simple, safe merge that:
 * 1. Determines which item to keep (keeper) using smart detection
 * 2. Sums the view counts from both items
 * 3. Soft-deletes the duplicate item
 * 4. Creates an audit log entry
 *
 * The keeper retains: title, format, comments, history, Descript data, sourceType, etc.
 * The duplicate is soft-deleted (archived, not permanently removed).
 */
export async function mergeProductionItems(
  primaryId: string,
  secondaryId: string,
  userId: string | null,
  opts: { forceKeeperId?: string } = {}
): Promise<MergeResult> {
  if (primaryId === secondaryId) {
    return {
      success: false,
      message: "Cannot merge an item with itself",
      primaryId,
      secondaryId,
      deletedId: "",
    };
  }

  try {
    // 1. Fetch both items
    const [itemById1] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, primaryId));

    const [itemById2] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, secondaryId));

    if (!itemById1 || !itemById2) {
      return {
        success: false,
        message: "One or both items not found",
        primaryId,
        secondaryId,
        deletedId: "",
      };
    }

    // Validate they belong to same account
    if (itemById1.accountId !== itemById2.accountId) {
      return {
        success: false,
        message: "Items belong to different accounts, cannot merge",
        primaryId,
        secondaryId,
        deletedId: "",
      };
    }

    // 2. Decide the keeper. Callers that already know which row must survive
    // (e.g. schedule-reconcile pins the Scheduled planning item so its hook /
    // format / assignment / comments win) pass forceKeeperId to bypass the
    // ownership heuristic.
    let keeper: typeof productionItems.$inferSelect;
    let duplicate: typeof productionItems.$inferSelect;
    if (opts.forceKeeperId) {
      if (opts.forceKeeperId === itemById1.id) {
        keeper = itemById1;
        duplicate = itemById2;
      } else if (opts.forceKeeperId === itemById2.id) {
        keeper = itemById2;
        duplicate = itemById1;
      } else {
        return {
          success: false,
          message: "forceKeeperId does not match either item",
          primaryId,
          secondaryId,
          deletedId: "",
        };
      }
    } else {
      ({ keeper, duplicate } = await determineKeeper(itemById1, itemById2));
    }
    const primary = keeper;
    const secondary = duplicate;

    // Log if we swapped the IDs for transparency
    if (primary.id !== primaryId) {
      console.log(
        `[merge-production-items] Auto-swapped IDs: keeping ${primary.id} (${primary.title}), deleting ${secondary.id} (${secondary.title})`
      );
    }

    // 3. Repoint foreign keys from secondary to primary
    // These tables have FKs pointing to production_items.id:
    // transcripts.production_item_id (CASCADE)
    // production_item_media.production_item_id (CASCADE)
    // clip_ideas.source_production_item_id (CASCADE)
    // clip_ideas.accepted_production_item_id (SET NULL)
    // content_drafts.production_item_id (CASCADE)
    // repurpose_triggers.production_item_id
    // cross_post_fit_verdicts.source_item_id (CASCADE)
    // view_snapshots.production_item_id (CASCADE)
    // cross_post_decisions.source_item_id (CASCADE)
    // cross_post_decisions.idea_item_id (SET NULL)
    // content_comments.content_item_id (CASCADE)
    // content_events.content_item_id (CASCADE)
    // notifications.content_item_id (CASCADE)

    const repointTables = [
      "transcripts",
      "production_item_media",
      "clip_ideas",
      "content_drafts",
      "repurpose_triggers",
      "cross_post_fit_verdicts",
      "view_snapshots",
      "cross_post_decisions",
      "content_comments",
      "content_events",
      "notifications",
    ];

    // Repoint foreign keys from secondary to primary
    // Most tables use CASCADE delete, so soft-delete of secondary will clean up automatically
    for (const table of repointTables) {
      const columnName = table === "clip_ideas"
        ? "source_production_item_id"
        : table === "cross_post_decisions"
        ? "source_item_id"
        : "production_item_id";

      try {
        // Try to update all references from secondary to primary
        await db.execute(
          sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(columnName)} = ${primaryId} WHERE ${sql.identifier(columnName)} = ${secondaryId}`
        );
      } catch (err: any) {
        // If update fails (e.g., unique constraint), delete the secondary's rows instead
        // This is safe because these are child records that will be recreated if needed
        try {
          await db.execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(columnName)} = ${secondaryId}`
          );
        } catch (deleteErr: any) {
          // Log but continue - some tables might not have data anyway
          console.warn(
            `[merge-production-items] Failed to delete from ${table}:`,
            deleteErr.message
          );
        }
      }
    }

    // 4. Merge: Sum view counts and transfer platformContentId if keeper lacks it
    // This ensures the API can find and update the merged item in future syncs
    const primaryViews = primary.views || 0;
    const secondaryViews = secondary.views || 0;
    const combinedViews = primaryViews + secondaryViews;

    // 5. Clear secondary's platformContentId FIRST (before updating primary)
    // This removes the unique constraint conflict since soft-deletes don't free up UNIQUE constraints
    if (secondary.platformContentId) {
      await db
        .update(productionItems)
        .set({
          platformContentId: null,
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, secondary.id));
    }

    // 6. Now update primary with merged data using raw SQL
    // Build the complete SQL statement properly (don't nest template literals)
    let updateSql;

    if (!primary.platformContentId && secondary.platformContentId) {
      // Transfer platformContentId if keeper doesn't have it
      updateSql = sql`UPDATE production_items SET views = ${combinedViews}, platform_content_id = ${secondary.platformContentId}, updated_at = now() WHERE id = ${primary.id}`;
    } else {
      // Just update views and timestamp
      updateSql = sql`UPDATE production_items SET views = ${combinedViews}, updated_at = now() WHERE id = ${primary.id}`;
    }

    try {
      await db.execute(updateSql);
      console.log(
        `[merge-production-items] Successfully updated primary ${primary.id} with views=${combinedViews}${
          !primary.platformContentId && secondary.platformContentId
            ? `, platformContentId=${secondary.platformContentId}`
            : ""
        }`
      );
    } catch (updateErr: any) {
      console.error(
        `[merge-production-items] Failed to update primary ${primary.id}:`,
        updateErr.message
      );
      throw updateErr;
    }

    // 7. Now soft-delete secondary (safe since its platformContentId is already cleared)
    await db
      .update(productionItems)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, secondary.id));

    // 8. Create audit log entry. Only for user-initiated merges — the
    // production_items_merges table requires a non-null merged_by, so
    // system reconciles (userId null) record their trail via content_events
    // instead (see reconcileScheduledIntoPublished).
    if (userId) {
      try {
        await db.execute(sql`
          INSERT INTO production_items_merges (id, primary_item_id, secondary_item_id, merged_by, merge_strategy, created_at)
          VALUES (gen_random_uuid(), ${primary.id}, ${secondary.id}, ${userId}, 'smart_merge', now())
        `);
      } catch (err: any) {
        // Table might not exist yet (migration pending), log but don't fail the merge
        console.warn("[merge-production-items] audit log insert failed:", err.message);
      }
    }

    return {
      success: true,
      message: `Successfully merged duplicate into primary item. Kept editor metadata, transferred API data and metrics.`,
      primaryId: primary.id,
      secondaryId: secondary.id,
      deletedId: secondary.id,
    };
  } catch (err: any) {
    console.error("[merge-production-items] merge failed:", err);
    return {
      success: false,
      message: `Merge failed: ${err.message}`,
      primaryId,
      secondaryId,
      deletedId: "",
    };
  }
}

export interface ReconcileResult {
  success: boolean;
  message: string;
  /** The surviving Published item id (= the original Scheduled item). */
  publishedItemId: string | null;
}

/**
 * "The Scheduled item becomes the published row." Used by schedule-reconcile
 * when a synced Published post is confidently matched to a Scheduled planning
 * item. Pins the Scheduled item as keeper so its hook / format / assignment /
 * comments survive, absorbs the synced duplicate via mergeProductionItems
 * (which repoints child FKs, transfers platformContentId + views, and
 * soft-deletes the synced row), then stamps the real published fields onto
 * the keeper and flips it to Published — mirroring the publish route's
 * Scheduled → Published transition (events + velocity snapshots).
 *
 * `userId` is null for the cron-driven path; the activity trail is captured
 * via content_events with a sync source rather than the merges audit table.
 */
export async function reconcileScheduledIntoPublished(
  scheduledId: string,
  syncedId: string,
  userId: string | null
): Promise<ReconcileResult> {
  // Capture the synced row's real published data before the merge soft-
  // deletes it (the merge only nulls platformContentId, but read up front so
  // we never depend on the soft-deleted row's other columns).
  const [synced] = await db
    .select({
      publishedLink: productionItems.publishedLink,
      publishedDate: productionItems.publishedDate,
      publishedAt: productionItems.publishedAt,
      thumbnail: productionItems.thumbnail,
    })
    .from(productionItems)
    .where(eq(productionItems.id, syncedId))
    .limit(1);
  const [scheduled] = await db
    .select({
      status: productionItems.status,
      publishedLink: productionItems.publishedLink,
      publishedDate: productionItems.publishedDate,
    })
    .from(productionItems)
    .where(eq(productionItems.id, scheduledId))
    .limit(1);

  if (!synced || !scheduled) {
    return {
      success: false,
      message: "Scheduled or synced item not found",
      publishedItemId: null,
    };
  }

  const merge = await mergeProductionItems(scheduledId, syncedId, userId, {
    forceKeeperId: scheduledId,
  });
  if (!merge.success) {
    return { success: false, message: merge.message, publishedItemId: null };
  }

  // Stamp the keeper with the live post's published fields + flip status.
  const publishedAt = synced.publishedAt ?? new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(productionItems)
      .set({
        status: "Published",
        publishedLink: synced.publishedLink,
        publishedDate: synced.publishedDate,
        publishedAt,
        thumbnail: synced.thumbnail,
        scheduleNeedsAttentionAt: null,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, scheduledId));

    const changes: ContentChange[] = [
      {
        target: { kind: "production_item_field", field: "status" },
        from: scheduled.status,
        to: "Published",
      },
    ];
    if (scheduled.publishedLink !== synced.publishedLink) {
      changes.push({
        target: { kind: "production_item_field", field: "publishedLink" },
        from: scheduled.publishedLink,
        to: synced.publishedLink,
      });
    }
    if (scheduled.publishedDate !== synced.publishedDate) {
      changes.push({
        target: { kind: "production_item_field", field: "publishedDate" },
        from: scheduled.publishedDate,
        to: synced.publishedDate,
      });
    }
    await recordContentChanges({
      tx,
      contentItemId: scheduledId,
      userId,
      source: { kind: "sync", system: "account-content" },
      changes,
    });
    await tx.insert(contentEvents).values({
      contentItemId: scheduledId,
      userId,
      eventType: "status_change",
      payload: {
        type: "status_change",
        from: scheduled.status,
        to: "Published",
      },
    });
  });

  // Mirror the publish route: schedule the early velocity checkpoints.
  try {
    await scheduleVelocitySnapshots(scheduledId, publishedAt);
  } catch (err) {
    console.error("[reconcile] scheduleVelocitySnapshots failed", err);
  }

  return {
    success: true,
    message: "Reconciled scheduled item into published post",
    publishedItemId: scheduledId,
  };
}
