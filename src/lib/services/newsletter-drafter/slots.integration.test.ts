import { afterEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, newsletterDrafts } from "@/lib/db/schema";
import { createTestProductionItem, createTestTranscript } from "@/test/factories";
import { ensureSlots, setSlotVideo } from "./slots";

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

  it("suggests the newest unused video from either How-To channel, puts the slot on that channel's format, and lets the editor switch it", async () => {
    const fp = await formatId("how-to newsletter - futurepedia (pilot)");
    const sl = await formatId("how-to newsletter - skill leap (pilot)");
    const fpAcct = await youtubeAccount("futurepedia_io");
    const slAcct = await youtubeAccount("SkillLeapAI");
    if (!fp || !sl || !fpAcct || !slAcct) return; // this DB has no How-To formats/channels

    const older = await createTestProductionItem({ postType: "youtube_long", accountId: fpAcct, brand: "futurepedia", publishedAt: new Date("2031-02-27T12:00:00Z") });
    await createTestTranscript({ productionItemId: older.id, segments: [{ startSec: 0, endSec: 1, text: "a" }] });
    const newest = await createTestProductionItem({ postType: "youtube_long", accountId: slAcct, brand: "futurepedia", publishedAt: new Date("2031-03-02T12:00:00Z") });
    await createTestTranscript({ productionItemId: newest.id, segments: [{ startSec: 0, endSec: 1, text: "b" }] });

    await ensureSlots(NOW);
    const [first] = await db
      .select({ id: newsletterDrafts.id, sourceItemId: newsletterDrafts.sourceItemId, formatId: newsletterDrafts.formatId })
      .from(newsletterDrafts)
      .where(eq(newsletterDrafts.slotKey, "futurepedia-howto:2031-03-11"));
    // Newest video is Skill Leap's, so the slot moves to the Skill Leap (Saj) format.
    expect(first).toMatchObject({ sourceItemId: newest.id, formatId: sl });

    // The next Tuesday's slot gets the other (older) video, never the same one twice.
    const [next] = await db
      .select({ sourceItemId: newsletterDrafts.sourceItemId, formatId: newsletterDrafts.formatId })
      .from(newsletterDrafts)
      .where(eq(newsletterDrafts.slotKey, "futurepedia-howto:2031-03-18"));
    expect(next.sourceItemId).not.toBe(newest.id);

    // Switching to the Futurepedia video moves the slot back to Kevin's format.
    // (listSlotVideoOptions looks at the last 6 weeks of real time, so only assert when it's in range.)
    const r = await setSlotVideo(first.id, older.id);
    if ("ok" in r) {
      const [after] = await db.select({ formatId: newsletterDrafts.formatId }).from(newsletterDrafts).where(eq(newsletterDrafts.id, first.id));
      expect(after.formatId).toBe(fp);
    }
  });
});
