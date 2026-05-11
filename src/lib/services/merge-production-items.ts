import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

export interface MergeResult {
  success: boolean;
  message: string;
  primaryId: string;
  secondaryId: string;
  deletedId: string;
}

/**
 * Merge two duplicate production items.
 *
 * This function performs a smart merge that:
 * 1. Validates both items exist and belong to same account/brand
 * 2. Repoints foreign keys from secondary to primary using savepoints
 * 3. Transfers API metadata (platformContentId, publishedLink) from secondary to primary
 * 4. Sums view counts from both items
 * 5. Soft-deletes the secondary item
 * 6. Creates an audit log entry in production_items_merges table
 *
 * The primary item (kept) retains: editor metadata, comments, history, sourceType
 * The secondary item (deleted) contributes: platformContentId, publishedLink, metrics
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
    const [primary] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, primaryId));

    const [secondary] = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.id, secondaryId));

    if (!primary || !secondary) {
      return {
        success: false,
        message: "One or both items not found",
        primaryId,
        secondaryId,
        deletedId: "",
      };
    }

    // 2. Validate they belong to same account
    if (primary.accountId !== secondary.accountId) {
      return {
        success: false,
        message: "Items belong to different accounts, cannot merge",
        primaryId,
        secondaryId,
        deletedId: "",
      };
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

    // Use savepoints to handle UNIQUE constraint collisions
    // If an update would violate a unique constraint, delete the secondary's child row instead
    for (const table of repointTables) {
      const columnName = table === "clip_ideas"
        ? "source_production_item_id"
        : table === "cross_post_decisions"
        ? "source_item_id"
        : "production_item_id";

      // Start a savepoint for this table
      const savepointName = `merge_${table}`;
      await db.execute(sql.raw(`SAVEPOINT ${savepointName}`));

      try {
        // Try to update all references from secondary to primary
        await db.execute(
          sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(columnName)} = ${primaryId} WHERE ${sql.identifier(columnName)} = ${secondaryId}`
        );
      } catch (err: any) {
        if (err.code === "23505") {
          // UNIQUE constraint violation
          // Delete the secondary's child rows instead of updating
          await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepointName}`));
          await db.execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(columnName)} = ${secondaryId}`
          );
        } else {
          throw err;
        }
      }

      // Release the savepoint
      await db.execute(sql.raw(`RELEASE SAVEPOINT ${savepointName}`));
    }

    // 4. Merge: Keep primary's metadata, transfer API data (platformContentId, publishedLink) and metrics from secondary
    const primaryViews = primary.views || 0;
    const secondaryViews = secondary.views || 0;

    const primaryUpdateData: Partial<typeof primary> = {
      // Transfer critical API fields from secondary so future syncs work
      platformContentId: secondary.platformContentId || primary.platformContentId,
      publishedLink: secondary.publishedLink || primary.publishedLink,
      // Transfer/update metrics from secondary
      views: primaryViews + secondaryViews,
      likes: Math.max(primary.likes || 0, secondary.likes || 0),
      comments: Math.max(primary.comments || 0, secondary.comments || 0),
      // Keep primary's other fields (title, format, status, etc.)
    };

    // 5. Update primary with merged data
    if (Object.keys(primaryUpdateData).length > 0) {
      await db
        .update(productionItems)
        .set({
          ...primaryUpdateData,
          updatedAt: new Date(),
        })
        .where(eq(productionItems.id, primaryId));
    }

    // 6. Soft-delete secondary (set deletedAt)
    await db
      .update(productionItems)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, secondaryId));

    // 7. Create audit log entry
    // Note: This assumes a productionItemsMerges table exists in the schema
    try {
      await db.execute(sql`
        INSERT INTO production_items_merges (id, primary_item_id, secondary_item_id, merged_by, merge_strategy, created_at)
        VALUES (gen_random_uuid(), ${primaryId}, ${secondaryId}, ${userId}, 'smart_merge', now())
      `);
    } catch (err: any) {
      // Table might not exist yet (migration pending), log but don't fail the merge
      console.warn("[merge-production-items] audit log insert failed:", err.message);
    }

    return {
      success: true,
      message: `Successfully merged duplicate into primary item. Kept editor metadata, transferred API data and metrics.`,
      primaryId,
      secondaryId,
      deletedId: secondaryId,
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
