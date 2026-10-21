import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { advanceNewsletterItem, stagesBefore } from "./queue-status";

const drafts: string[] = [];
afterEach(async () => {
  if (drafts.length) await db.delete(newsletterDrafts).where(inArray(newsletterDrafts.id, drafts.splice(0)));
});

async function edition(status: string) {
  const fmt = await createTestFormat({ brand: "vitest-nlq" });
  const item = await createTestProductionItem({ postType: "newsletter", status });
  const [d] = await db
    .insert(newsletterDrafts)
    .values({ brand: "vitest-nlq", formatId: fmt.id, windowStart: new Date(), windowEnd: new Date(), productionItemId: item.id })
    .returning({ id: newsletterDrafts.id });
  drafts.push(d.id);
  return { draftId: d.id, itemId: item.id };
}
const statusOf = async (id: string) => (await db.select({ s: productionItems.status }).from(productionItems).where(eq(productionItems.id, id)))[0].s;

describe("newsletter queue item stages", () => {
  it("orders the stages Idea → Assigned → Review → Ready To Publish", () => {
    expect(stagesBefore("Review")).toEqual(["Idea", "Assigned"]);
    expect(stagesBefore("Idea")).toEqual([]);
  });

  it("moves an item forward, never backward, and leaves hand-set stages alone", async () => {
    const a = await edition("Idea");
    await advanceNewsletterItem(a.draftId, "Review");
    expect(await statusOf(a.itemId)).toBe("Review");
    await advanceNewsletterItem(a.draftId, "Assigned"); // a Redraft doesn't move it back
    expect(await statusOf(a.itemId)).toBe("Review");
    const held = await edition("On Hold");
    await advanceNewsletterItem(held.draftId, "Ready To Publish");
    expect(await statusOf(held.itemId)).toBe("On Hold");
  });
});
