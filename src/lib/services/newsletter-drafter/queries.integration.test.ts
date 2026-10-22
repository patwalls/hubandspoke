import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { createTestAccount, createTestFormat, createTestProductionItem, createTestTranscript } from "@/test/factories";
import { createNewsletterDraft, listFormatVideos } from "./queries";

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
