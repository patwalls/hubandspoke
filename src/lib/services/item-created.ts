// One-liner the every production_items insert site can call to write a
// matching content_events row of `eventType='item_created'`. Pairs with
// the `productionItems.createdVia` column (set inline in the insert
// values) so two queries answer "where did this row come from?":
//
//   • Fast filter: `SELECT id, title FROM production_items WHERE
//     created_via = 'sync:account-content' AND format IS NOT NULL;` —
//     find items a sync wrote but a human later tagged.
//   • Full audit: `SELECT payload FROM content_events WHERE
//     event_type = 'item_created' AND content_item_id = '…';` — surfaces
//     the actor user, format, sourceType, postType at the moment of
//     creation. Renders as the first activity row on /[brand]/content/[id].
//
// This file lives under `src/lib/services/` rather than `src/lib/db/`
// because it's a behavior helper (writes side-effects) not a query.

import type { ContentEventPayload } from "@/lib/db/schema";
import { contentEvents } from "@/lib/db/schema";

/** Drizzle DB or transaction. Typed loosely so this works equally well
 *  when called inside `db.transaction(async (tx) => …)` or directly on
 *  the top-level `db`. The only method we need is `.insert(...).values(...)`. */
interface InsertableDb {
  insert: (table: typeof contentEvents) => {
    values: (
      row: Omit<typeof contentEvents.$inferInsert, "id" | "createdAt">,
    ) => Promise<unknown>;
  };
}

export interface RecordItemCreatedArgs {
  /** The just-inserted production_items.id. */
  itemId: string;
  /** Same string written to productionItems.createdVia for this row.
   *  Convention: `<kind>:<name>` (e.g. "api:create", "sync:account-content",
   *  "cron:threshold-monitor-sweep"). See `productionItems.createdVia`
   *  comment for the canonical set. */
  source: string;
  /** Acting user, when known. Null for cron/sync paths with no user
   *  context. The content_events table's user_id FK is ON DELETE SET NULL,
   *  so this never blocks insertion. */
  actorUserId: string | null;
  /** Snapshot of the format string at creation time. Useful audit data
   *  because format can be edited post-creation. */
  format: string | null;
  /** sourceType snapshot (default 'original' when not specified by caller). */
  sourceType: string;
  /** postType snapshot, when known. Null for rows created without one
   *  (e.g. cross-post drafts that get the postType filled in later). */
  postType: string | null;
}

/**
 * Write a single content_events row stamping how this production_item
 * was created. Best-effort: callers should NOT abort their main insert
 * on a failure here (auditing is downstream of "did the row get
 * created?"). Wrap the call in a try/catch + console.error at the
 * call site if the surrounding tx isn't already swallowing.
 */
export async function recordItemCreated(
  tx: InsertableDb,
  args: RecordItemCreatedArgs,
): Promise<void> {
  const payload: Extract<ContentEventPayload, { type: "item_created" }> = {
    type: "item_created",
    source: args.source,
    format: args.format,
    sourceType: args.sourceType,
    postType: args.postType,
  };
  await tx.insert(contentEvents).values({
    contentItemId: args.itemId,
    userId: args.actorUserId,
    eventType: "item_created",
    payload,
  });
}
