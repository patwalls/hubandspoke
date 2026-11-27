import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentComments, contentEvents } from "@/lib/db/schema";
import {
  createTestAccount,
  createTestComment,
  createTestProductionItem,
} from "@/test/factories";
import {
  mergeProductionItems,
  reconcileScheduledIntoPublished,
} from "./merge-production-items";

describe("mergeProductionItems", () => {
  // Regression: the repoint list used `production_item_id` for tables keyed on
  // `content_item_id`, so the UPDATE failed, was swallowed, and a merged post's
  // comments stayed behind on the soft-deleted row.
  it("moves the duplicate's comments onto the kept post", async () => {
    const acct = await createTestAccount({ platform: "facebook", isActive: true });
    const keeper = await createTestProductionItem({ accountId: acct.id });
    const duplicate = await createTestProductionItem({ accountId: acct.id });
    const comment = await createTestComment({ contentItemId: duplicate.id });

    const merged = await mergeProductionItems(keeper.id, duplicate.id, null, {
      forceKeeperId: keeper.id,
    });

    expect(merged.success).toBe(true);
    const [after] = await db
      .select()
      .from(contentComments)
      .where(eq(contentComments.id, comment.id));
    expect(after.contentItemId).toBe(keeper.id);
  });
});

describe("reconcileScheduledIntoPublished", () => {
  async function statusChanges(itemId: string) {
    return db
      .select({ payload: contentEvents.payload })
      .from(contentEvents)
      .where(
        and(
          eq(contentEvents.contentItemId, itemId),
          eq(contentEvents.eventType, "status_change"),
        ),
      );
  }

  // Regression (prod 2026-11-25): the link was pasted first (item already
  // Published), the sync then matched the live post and the post's Activity
  // read "changed status from Published to Published".
  it("writes no status change when the planning item is already Published", async () => {
    const acct = await createTestAccount({ platform: "facebook", isActive: true });
    const planned = await createTestProductionItem({ accountId: acct.id, status: "Published" });
    const synced = await createTestProductionItem({ accountId: acct.id, status: "Published" });

    const r = await reconcileScheduledIntoPublished(planned.id, synced.id, null);

    expect(r.success).toBe(true);
    expect(await statusChanges(planned.id)).toEqual([]);
  });

  it("records Scheduled → Published when the planning item was Scheduled", async () => {
    const acct = await createTestAccount({ platform: "facebook", isActive: true });
    const planned = await createTestProductionItem({ accountId: acct.id, status: "Scheduled" });
    const synced = await createTestProductionItem({ accountId: acct.id, status: "Published" });

    await reconcileScheduledIntoPublished(planned.id, synced.id, null);

    expect((await statusChanges(planned.id)).map((e) => e.payload)).toEqual([
      { type: "status_change", from: "Scheduled", to: "Published" },
    ]);
  });
});
