import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, newsletterDrafts } from "@/lib/db/schema";
import { createTestProductionItem, createTestTranscript } from "@/test/factories";
import { ensureSlots } from "./slots";

// Runs ensureSlots "in" 2031 so its slots can't collide with real ones, and
// deletes exactly those slots afterwards (slot rows aren't factory-tracked).
const NOW = new Date("2031-03-04T15:00:00Z"); // a Tuesday
const FAR = "%:2031-03-%";

async function formatId(name: string): Promise<string | null> {
  const [f] = await db.select({ id: formats.id }).from(formats).where(sql`lower(${formats.name}) = ${name}`).limit(1);
  return f?.id ?? null;
}
async function youtubeAccount(handle: string): Promise<string | null> {
  const [a] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.platform, "youtube"), sql`lower(${accounts.handle}) = lower(${handle})`))
    .limit(1);
  return a?.id ?? null;
}

afterEach(async () => {
  await db.delete(newsletterDrafts).where(like(newsletterDrafts.slotKey, FAR));
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

  it("queues one How-To edition per published video, on that video's channel's format, never twice", async () => {
    const fp = await formatId("how-to newsletter - futurepedia (pilot)");
    const sl = await formatId("how-to newsletter - skill leap (pilot)");
    const fpAcct = await youtubeAccount("futurepedia_io");
    const slAcct = await youtubeAccount("SkillLeapAI");
    if (!fp || !sl || !fpAcct || !slAcct) return; // this DB has no How-To formats/channels

    // Thu Feb 27 (Futurepedia) and Sun Mar 2 (Skill Leap); "today" is Tue Mar 4.
    const kevinVideo = await createTestProductionItem({ postType: "youtube_long", accountId: fpAcct, brand: "futurepedia", publishedAt: new Date("2031-02-27T17:00:00Z") });
    await createTestTranscript({ productionItemId: kevinVideo.id, segments: [{ startSec: 0, endSec: 1, text: "a" }] });
    const sajVideo = await createTestProductionItem({ postType: "youtube_long", accountId: slAcct, brand: "futurepedia", publishedAt: new Date("2031-03-02T17:00:00Z") });
    await createTestTranscript({ productionItemId: sajVideo.id, segments: [{ startSec: 0, endSec: 1, text: "b" }] });

    await ensureSlots(NOW);
    const rows = await db
      .select({ id: newsletterDrafts.id, slotKey: newsletterDrafts.slotKey, sourceItemId: newsletterDrafts.sourceItemId, formatId: newsletterDrafts.formatId, pinned: newsletterDrafts.sourcePinned })
      .from(newsletterDrafts)
      .where(like(newsletterDrafts.slotKey, "futurepedia-howto:2031-03-%"));
    const byVideo = new Map(rows.map((r) => [r.sourceItemId, r]));
    // First come, first served: Friday Mar 7 for the older video, then Wed Mar 5 as the week's extra send.
    expect(byVideo.get(kevinVideo.id)).toMatchObject({ slotKey: "futurepedia-howto:2031-03-07", formatId: fp, pinned: true });
    expect(byVideo.get(sajVideo.id)).toMatchObject({ slotKey: "futurepedia-howto:2031-03-05", formatId: sl, pinned: true });
    expect(rows.length).toBe(2); // no empty Tue/Fri slots

    await ensureSlots(NOW);
    const again = await db.select({ id: newsletterDrafts.id }).from(newsletterDrafts).where(like(newsletterDrafts.slotKey, "futurepedia-howto:2031-03-%"));
    expect(again.length).toBe(2);
  });
});
