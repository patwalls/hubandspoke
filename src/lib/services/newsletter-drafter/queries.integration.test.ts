import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, newsletterDrafts, productionItems } from "@/lib/db/schema";
import { createTestAccount, createTestFormat, createTestProductionItem, createTestTranscript } from "@/test/factories";
import { createNewsletterDraft, listFormatVideos, startEditionDraft } from "./queries";

// Format behavior is keyed by name (format-config.ts), so the test uses the
// real How-To name under a throwaway brand: the (brand, name) unique index
// then never clashes with the real format.
const HOW_TO = "Futurepedia Newsletter";

/** The futurepedia_io YouTube account the How-To config points at (created on a fresh DB). */
async function futurepediaChannelId(): Promise<string> {
  const [existing] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.platform, "youtube"), sql`lower(${accounts.handle}) = 'futurepedia_io'`))
    .limit(1);
  if (existing) return existing.id;
  return (await createTestAccount({ brand: "futurepedia", platform: "youtube", handle: "futurepedia_io" })).id;
}

describe("single-video newsletter formats", () => {
  it("lists recent videos from the format's own channel, with their transcript flag", async () => {
    const fmt = await createTestFormat({ brand: "vitest-howto", name: HOW_TO });
    const channelId = await futurepediaChannelId();
    const withTranscript = await createTestProductionItem({ postType: "youtube_long", accountId: channelId, brand: "futurepedia" });
    await createTestTranscript({ productionItemId: withTranscript.id, segments: [{ startSec: 0, endSec: 3, text: "hi" }] });
    const noTranscript = await createTestProductionItem({ postType: "youtube_long", accountId: channelId, brand: "futurepedia" });
    const otherChannel = await createTestProductionItem({ postType: "youtube_long" }); // Starter Story's test account

    const listed = await listFormatVideos(fmt.id);
    expect(listed?.find((v) => v.id === withTranscript.id)?.hasTranscript).toBe(true);
    expect(listed?.find((v) => v.id === noTranscript.id)?.hasTranscript).toBe(false);
    expect(listed?.some((v) => v.id === otherChannel.id)).toBe(false);
  });

  it("requires a video, and only one from the format's channels", async () => {
    const fmt = await createTestFormat({ brand: "vitest-howto", name: HOW_TO });
    const foreign = await createTestProductionItem({ postType: "youtube_long" });
    expect(await createNewsletterDraft({ formatId: fmt.id, userId: null })).toEqual({ error: "Pick a video for this format" });
    expect(await createNewsletterDraft({ formatId: fmt.id, sourceItemId: foreign.id, userId: null })).toEqual({
      error: "That video isn't from this format's channels",
    });
  });
});

describe("roundup formats about one piece of pillar content", () => {
  it("accepts one of the brand's videos with a transcript and pins it; refuses another brand's video or one without a transcript", async () => {
    const fmt = await createTestFormat({ brand: "starter-story", name: "Vitest Roundup Newsletter" });
    const mine = await createTestProductionItem({ postType: "youtube_long" }); // Starter Story's test account
    await createTestTranscript({ productionItemId: mine.id, segments: [{ startSec: 0, endSec: 3, text: "hi" }] });
    const noTranscript = await createTestProductionItem({ postType: "youtube_long" });
    const otherBrand = await createTestProductionItem({ postType: "youtube_long", accountId: await futurepediaChannelId(), brand: "futurepedia" });

    const created = await createNewsletterDraft({ formatId: fmt.id, sourceItemId: mine.id, userId: null });
    expect(created && "id" in created).toBe(true);
    const [row] = await db
      .select({ sourceItemId: newsletterDrafts.sourceItemId, pinned: newsletterDrafts.sourcePinned })
      .from(newsletterDrafts)
      .where(eq(newsletterDrafts.id, (created as { id: string }).id));
    expect(row).toEqual({ sourceItemId: mine.id, pinned: true });
    await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, (created as { id: string }).id));

    expect(await createNewsletterDraft({ formatId: fmt.id, sourceItemId: noTranscript.id, userId: null })).toEqual({ error: "That video has no transcript yet" });
    expect(await createNewsletterDraft({ formatId: fmt.id, sourceItemId: otherBrand.id, userId: null })).toEqual({ error: "That isn't one of this brand's videos" });

    // A plain roundup (no pick) stays unpinned.
    const plain = await createNewsletterDraft({ formatId: fmt.id, days: 7, userId: null });
    const [p] = await db.select({ sourceItemId: newsletterDrafts.sourceItemId }).from(newsletterDrafts).where(eq(newsletterDrafts.id, (plain as { id: string }).id));
    expect(p.sourceItemId).toBeNull();
    await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, (plain as { id: string }).id));
  });
});

// Pat, 2026-10-27: opening a queue newsletter drafted it from stories the drafter
// picked itself. The queue now asks for the pillar + angle first; starting the
// slot must carry them onto the edition (and the queue item's pillar).
describe("starting a scheduled edition from the queue", () => {
  async function slot(formatId: string) {
    const item = await createTestProductionItem({ postType: "newsletter" });
    const now = new Date();
    const [d] = await db
      .insert(newsletterDrafts)
      .values({ brand: "starter-story", formatId, status: "idea", sendDate: "2026-11-05", windowStart: now, windowEnd: now, productionItemId: item.id })
      .returning({ id: newsletterDrafts.id });
    return { draftId: d.id, itemId: item.id };
  }
  const rowOf = async (id: string) => (await db.select().from(newsletterDrafts).where(eq(newsletterDrafts.id, id)))[0];

  it("drafts the slot about the chosen pillar video, with the angle, and points the queue item at it", async () => {
    const fmt = await createTestFormat({ brand: "starter-story", name: "Vitest Roundup Newsletter" });
    const video = await createTestProductionItem({ postType: "youtube_long" });
    await createTestTranscript({ productionItemId: video.id, segments: [{ startSec: 0, endSec: 3, text: "hi" }] });
    const s = await slot(fmt.id);

    expect(await startEditionDraft({ id: s.draftId, sourceItemId: video.id, notes: "  why SEO compounds ", userId: null })).toEqual({ ok: true });
    const row = await rowOf(s.draftId);
    expect(row).toMatchObject({ status: "drafting", sourceItemId: video.id, sourcePinned: true, notes: "why SEO compounds" });
    const [item] = await db.select({ pillar: productionItems.pillarContentItemId }).from(productionItems).where(eq(productionItems.id, s.itemId));
    expect(item.pillar).toBe(video.id);
    // Already drafting: a second start is refused.
    expect(await startEditionDraft({ id: s.draftId, sourceItemId: video.id, userId: null })).toMatchObject({ status: 409 });
    await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, s.draftId));
  });

  it("refuses a video the format can't use and leaves the slot undrafted; a redraft without a pick keeps the pillar", async () => {
    const fmt = await createTestFormat({ brand: "starter-story", name: "Vitest Roundup Newsletter" });
    const noTranscript = await createTestProductionItem({ postType: "youtube_long" });
    const s = await slot(fmt.id);

    expect(await startEditionDraft({ id: s.draftId, sourceItemId: noTranscript.id, userId: null })).toEqual({ error: "That video has no transcript yet", status: 400 });
    expect((await rowOf(s.draftId)).status).toBe("idea");

    // The editor's Redraft / Try again send no pick: nothing about the pillar changes.
    await db.update(newsletterDrafts).set({ sourceItemId: noTranscript.id, sourcePinned: true }).where(eq(newsletterDrafts.id, s.draftId));
    expect(await startEditionDraft({ id: s.draftId, userId: null })).toEqual({ ok: true });
    expect(await rowOf(s.draftId)).toMatchObject({ status: "drafting", sourceItemId: noTranscript.id, sourcePinned: true });
    await db.delete(newsletterDrafts).where(eq(newsletterDrafts.id, s.draftId));
  });
});
