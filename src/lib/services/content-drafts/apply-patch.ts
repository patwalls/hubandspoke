import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

type ContentDraftRow = typeof contentDrafts.$inferSelect;

/** Thrown when the item has no current draft at lock time (the chain was
 *  deleted mid-flight). The route maps this to a 409. */
export class NoCurrentDraftError extends Error {
  constructor(itemId: string) {
    super(`No current draft for production item ${itemId}`);
    this.name = "NoCurrentDraftError";
  }
}

/**
 * Coerce a content-draft field value to the primitive shape the
 * `content_changed` event payload expects. Tags become a comma-joined string
 * so the diff renders compactly; slides pass through as null (Stage 1 doesn't
 * edit them and the renderer can't diff an array of objects).
 */
export function coerceDraftFieldValue(
  v: unknown,
): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (Array.isArray(v)) {
    const parts = v
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.join(", ");
  }
  return null;
}

/**
 * Clone-on-write for an inline draft edit: demote the current draft to
 * `isCurrent=false` and insert a new `version + 1` row carrying the merged
 * content, emitting one `content_changed` event per field that moved — all in
 * one transaction so the version chain and audit trail commit atomically.
 *
 * Concurrency: the editor autosaves, and two overlapping saves can both read
 * the same current draft, both demote it, and both try to insert a second
 * `is_current=true` row → duplicate-key on `uq_content_drafts_current`
 * (HUBANDSPOKE-15/19/1V/1S). A per-item advisory xact lock serializes the
 * critical section, and the current draft is re-read UNDER the lock so a save
 * that lost the race clones from the winner's row — concurrent edits chain
 * (v2→v3→v4) instead of colliding.
 *
 * @param validatedPatch field values already validated against the schema by
 *   the caller — merged over whatever content is current at lock time.
 * @throws NoCurrentDraftError if the item has no current draft at lock time.
 */
export async function applyDraftPatch(params: {
  itemId: string;
  validatedPatch: Record<string, string | string[]>;
  actorUserId: string | null;
}): Promise<ContentDraftRow> {
  const { itemId, validatedPatch, actorUserId } = params;

  const [next] = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${itemId}))`);

    const [current] = await tx
      .select()
      .from(contentDrafts)
      .where(
        and(
          eq(contentDrafts.productionItemId, itemId),
          eq(contentDrafts.isCurrent, true),
        ),
      )
      .limit(1);
    if (!current) throw new NoCurrentDraftError(itemId);

    const baseContent = current.content as ContentDraftContent;
    const mergedContent: ContentDraftContent = {
      ...baseContent,
      ...validatedPatch,
    };

    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(contentDrafts.id, current.id));

    const [inserted] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId: itemId,
        version: current.version + 1,
        isCurrent: true,
        content: mergedContent,
        fieldSchemaSnapshot: current.fieldSchemaSnapshot as FormatFieldSchema,
        generatedBy: "user:edit",
        promptVersion: current.promptVersion,
        modelUsage: null,
        createdByUserId: actorUserId,
      })
      .returning();

    const changes: ContentChange[] = [];
    for (const key of Object.keys(validatedPatch)) {
      changes.push({
        target: {
          kind: "draft_field",
          draftId: inserted.id,
          version: inserted.version,
          field: key,
        },
        from: coerceDraftFieldValue(baseContent[key]),
        to: coerceDraftFieldValue(mergedContent[key]),
      });
    }
    await recordContentChanges({
      tx,
      contentItemId: itemId,
      userId: actorUserId,
      source: { kind: "user" },
      changes,
    });

    return [inserted];
  });

  return next;
}
