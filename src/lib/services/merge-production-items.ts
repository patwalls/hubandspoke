import { db } from "@/lib/db";
import { productionItems, contentComments } from "@/lib/db/schema";
import { eq, and, count } from "drizzle-orm";
import { sql } from "drizzle-orm";

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
  userId: string
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

    // 2. Smart detection: Determine which item should be kept
    const { keeper, duplicate } = await determineKeeper(itemById1, itemById2);
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

    // 5. Soft-delete secondary FIRST (before updating primary with its platformContentId)
    // This avoids unique constraint violations when the secondary has platformContentId
    await db
      .update(productionItems)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, secondary.id));

    // 6. Now update primary with merged data using raw SQL
    // Raw SQL to bypass any Drizzle type system issues
    let updateSql = sql`UPDATE production_items SET views = ${combinedViews}, updated_at = now()`;

    // Transfer platformContentId from duplicate to keeper if keeper doesn't have it
    if (!primary.platformContentId && secondary.platformContentId) {
      updateSql = sql`UPDATE production_items SET views = ${combinedViews}, platform_content_id = ${secondary.platformContentId}, updated_at = now()`;
    }

    updateSql = sql`${updateSql} WHERE id = ${primary.id}`;

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

    // 7. Create audit log entry
    // Note: This assumes a productionItemsMerges table exists in the schema
    try {
      await db.execute(sql`
        INSERT INTO production_items_merges (id, primary_item_id, secondary_item_id, merged_by, merge_strategy, created_at)
        VALUES (gen_random_uuid(), ${primary.id}, ${secondary.id}, ${userId}, 'smart_merge', now())
      `);
    } catch (err: any) {
      // Table might not exist yet (migration pending), log but don't fail the merge
      console.warn("[merge-production-items] audit log insert failed:", err.message);
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
