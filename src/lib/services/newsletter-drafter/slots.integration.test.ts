import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";
import { ensureSlots, insertVideoEdition, planVideoEdition } from "./slots";

// Runs ensureSlots "in" 2031 so its slots can't collide with real ones, and
// deletes exactly those slots afterwards (slot rows aren't factory-tracked).
const NOW = new Date("2031-03-04T15:00:00Z"); // a Tuesday
const FAR = "%:2031-03-%";

async function formatId(name: string): Promise<string | null> {
  const [f] = await db.select({ id: formats.id }).from(formats).where(sql`lower(${formats.name}) = ${name}`).limit(1);
  return f?.id ?? null;
}

afterEach(async () => {
  // Slot rows + the queue items they made aren't factory-tracked: delete exactly the 2031 ones.
  const items = await db.select({ id: newsletterDrafts.productionItemId }).from(newsletterDrafts).where(like(newsletterDrafts.slotKey, FAR));
  await db.delete(newsletterDrafts).where(like(newsletterDrafts.slotKey, FAR));
  const ids = items.map((i) => i.id).filter((x): x is string => !!x);
  if (ids.length) await db.delete(productionItems).where(inArray(productionItems.id, ids));
});

describe("ensureSlots", () => {
  it("creates each schedule's next two weeks once, and is a no-op the second time", async () => {
    const first = await ensureSlots(NOW);
    const rows = await db.select({ slotKey: newsletterDrafts.slotKey, status: newsletterDrafts.status }).from(newsletterDrafts).where(like(newsletterDrafts.slotKey, FAR));
    expect(rows.length).toBe(first.created);
    expect(rows.every((r) => r.status === "idea")).toBe(true);
    if (await formatId("sunday breakfast")) {
      expect(rows.map((r) => r.slotKey)).toEqual(expect.arrayContaining(["sunday-breakfast:2031-03-09", "sunday-breakfast:2031-03-16"]));
    }
    const second = await ensureSlots(NOW);
    expect(second.created).toBe(0);
  });

  it("gives each Sunday Breakfast / Daily Seinfeld slot a queue item, once", async () => {
    await ensureSlots(NOW);
    if (!(await formatId("sunday breakfast"))) return;
    const rows = await db
      .select({ itemId: newsletterDrafts.productionItemId, status: productionItems.status, format: productionItems.format, postType: productionItems.postType })
      .from(newsletterDrafts)
      .innerJoin(productionItems, eq(productionItems.id, newsletterDrafts.productionItemId))
      .where(like(newsletterDrafts.slotKey, "sunday-breakfast:2031-03-%"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "Idea" && r.format === "Sunday Breakfast" && r.postType === "newsletter")).toBe(true);
    const again = await ensureSlots(NOW);
    expect(again.queueItems).toBe(0);
  });

  it("plans one Futurepedia Newsletter edition per new video on the next open Tue/Fri, never twice", async () => {
    const fmt = await createTestFormat({ brand: "vitest-fpn", name: "Futurepedia Newsletter" });
    // Sun Mar 2 2031 video; "today" Tue Mar 4 → Fri Mar 7.
    const video = await createTestProductionItem({ postType: "youtube_long", brand: "futurepedia", publishedAt: new Date("2031-03-02T17:00:00Z") });
    const plan = await planVideoEdition("Futurepedia Newsletter", { id: video.id, publishedAt: video.publishedAt }, NOW);
    expect(plan).toEqual({ sendDate: "2031-03-07", group: "futurepedia-howto" });
    if (!("sendDate" in plan)) return;
    const item = await createTestProductionItem({ postType: "newsletter", brand: "futurepedia", status: "Idea" });
    expect(await insertVideoEdition({ ...plan, brand: "futurepedia", formatId: fmt.id, pillarId: video.id, productionItemId: item.id })).toBe(true);
    // Same video again: skipped. Too old a video: skipped.
    expect(await planVideoEdition("Futurepedia Newsletter", { id: video.id, publishedAt: video.publishedAt }, NOW)).toMatchObject({ skip: expect.stringMatching(/already has an edition/) });
    expect(await planVideoEdition("Futurepedia Newsletter", { id: "00000000-0000-0000-0000-000000000000", publishedAt: "2031-02-01T00:00:00Z" }, NOW)).toEqual({ skip: "published too long ago" });
    // A second new video the same week takes the next open day.
    const second = await createTestProductionItem({ postType: "youtube_long", brand: "futurepedia", publishedAt: new Date("2031-03-03T17:00:00Z") });
    expect(await planVideoEdition("Futurepedia Newsletter", { id: second.id, publishedAt: second.publishedAt }, NOW)).toEqual({ sendDate: "2031-03-05", group: "futurepedia-howto" });
  });
});
