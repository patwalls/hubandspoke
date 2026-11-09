import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentComments } from "@/lib/db/schema";
import {
  createTestAccount,
  createTestComment,
  createTestProductionItem,
} from "@/test/factories";
import { mergeProductionItems } from "./merge-production-items";

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
