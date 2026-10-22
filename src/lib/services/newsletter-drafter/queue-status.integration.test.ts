import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { advanceNewsletterItem, stagesBefore, syncNewsletterItemTitle } from "./queue-status";

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

describe("syncNewsletterItemTitle (the queue names an edition like its email tool)", () => {
  const titleOf = async (id: string) => (await db.select({ t: productionItems.title }).from(productionItems).where(eq(productionItems.id, id)))[0].t;

  async function titled(template: "futurepedia newsletter" | "sunday breakfast", draft: Partial<typeof newsletterDrafts.$inferInsert>, status = "Idea") {
    const e = await edition(status);
    const [d] = await db.select({ formatId: newsletterDrafts.formatId }).from(newsletterDrafts).where(eq(newsletterDrafts.id, e.draftId));
    await db.update(formats).set({ newsletterTemplate: DEFAULT_TEMPLATES[template] }).where(eq(formats.id, d.formatId));
    await db.update(newsletterDrafts).set(draft).where(eq(newsletterDrafts.id, e.draftId));
    return e;
  }

  it("a beehiiv newsletter takes its subject as the queue name, and follows later edits", async () => {
    const e = await titled("futurepedia newsletter", { subject: "Give Your Claude Videos a Voice" });
    await syncNewsletterItemTitle(e.draftId);
    expect(await titleOf(e.itemId)).toBe("Give Your Claude Videos a Voice");
    await db.update(newsletterDrafts).set({ subject: "Claude Can Narrate Your Videos" }).where(eq(newsletterDrafts.id, e.draftId));
    await syncNewsletterItemTitle(e.draftId);
    expect(await titleOf(e.itemId)).toBe("Claude Can Narrate Your Videos");
  });

  it("a HubSpot newsletter takes the email's name pattern + send date, without needing a subject", async () => {
    const e = await titled("sunday breakfast", { sendDate: "2026-10-25" });
    await syncNewsletterItemTitle(e.draftId);
    expect(await titleOf(e.itemId)).toMatch(/\| Newsletter \| October 25$/);
  });

  it("keeps the name when there is nothing better yet, and never renames a Published item", async () => {
    const before = await titled("futurepedia newsletter", { subject: null });
    const name = await titleOf(before.itemId);
    await syncNewsletterItemTitle(before.draftId);
    expect(await titleOf(before.itemId)).toBe(name);
    const sent = await titled("futurepedia newsletter", { subject: "New subject" }, "Published");
    const sentName = await titleOf(sent.itemId);
    await syncNewsletterItemTitle(sent.draftId);
    expect(await titleOf(sent.itemId)).toBe(sentName);
  });
});
