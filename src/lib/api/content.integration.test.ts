import { describe, expect, it } from "vitest";
import {
  createTestAccount,
  createTestClipIdea,
  createTestProductionItem,
  createTestTranscript,
} from "@/test/factories";
import { getContent, getTranscript, listClipIdeas, listContent, listDerivatives, renderTranscript } from "./content";
import { ApiError } from "./http";

const BASE = "https://hs.test";

describe("listContent", () => {
  it("scopes to an account, paginates with a cursor, and never shows deleted rows", async () => {
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    const days = [1, 2, 3, 4, 5].map((d) => new Date(`2026-09-0${d}T12:00:00Z`));
    const items = [];
    for (const publishedAt of days) {
      items.push(await createTestProductionItem({ accountId: account.id, publishedAt, title: `api-${publishedAt.toISOString()}` }));
    }
    await createTestProductionItem({ accountId: account.id, publishedAt: new Date("2026-09-09T00:00:00Z"), deletedAt: new Date() });

    const page1 = await listContent({ account_id: account.id, limit: 2 }, BASE);
    expect(page1.data.map((i) => i.published_at)).toEqual(["2026-09-05T12:00:00.000Z", "2026-09-04T12:00:00.000Z"]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await listContent({ account_id: account.id, limit: 2, cursor: page1.next_cursor }, BASE);
    expect(page2.data.map((i) => i.published_at)).toEqual(["2026-09-03T12:00:00.000Z", "2026-09-02T12:00:00.000Z"]);

    const page3 = await listContent({ account_id: account.id, limit: 2, cursor: page2.next_cursor }, BASE);
    expect(page3.data).toHaveLength(1);
    expect(page3.has_more).toBe(false);
    expect(page3.next_cursor).toBeNull();

    const all = [...page1.data, ...page2.data, ...page3.data].map((i) => i.id);
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual(expect.arrayContaining(items.map((i) => i.id)));
  });

  it("filters by date range, text, status (case-insensitive) and has_transcript", async () => {
    const account = await createTestAccount({ brand: "starter-story", platform: "x" });
    const a = await createTestProductionItem({
      accountId: account.id,
      title: "Newsletter growth playbook",
      status: "Published",
      publishedAt: new Date("2026-08-10T00:00:00Z"),
    });
    const b = await createTestProductionItem({
      accountId: account.id,
      title: "Hiring a first editor",
      status: "Idea",
      publishedAt: new Date("2026-08-20T00:00:00Z"),
    });
    await createTestTranscript({ productionItemId: a.id, segments: [{ startSec: 0, endSec: 1, text: "hi" }] });

    const byText = await listContent({ account_id: account.id, q: "newsletter" }, BASE);
    expect(byText.data.map((i) => i.id)).toEqual([a.id]);

    const byStatus = await listContent({ account_id: account.id, status: "idea" }, BASE);
    expect(byStatus.data.map((i) => i.id)).toEqual([b.id]);

    const byRange = await listContent(
      { account_id: account.id, published_after: new Date("2026-08-15T00:00:00Z"), published_before: new Date("2026-08-31T00:00:00Z") },
      BASE,
    );
    expect(byRange.data.map((i) => i.id)).toEqual([b.id]);

    const withTranscript = await listContent({ account_id: account.id, has_transcript: true }, BASE);
    expect(withTranscript.data.map((i) => i.id)).toEqual([a.id]);
    expect(withTranscript.data[0].has_transcript).toBe(true);
    expect(withTranscript.data[0].links.transcript).toBe(`${BASE}/api/v1/content/${a.id}/transcript`);
    expect(withTranscript.data[0].app_url).toBe(`${BASE}/starter-story/content/${a.id}`);
  });
});

describe("getContent / derivatives / clip ideas / transcript", () => {
  it("walks hub → spokes and exposes the hub id on each spoke", async () => {
    const account = await createTestAccount({ brand: "starter-story", platform: "youtube" });
    const hub = await createTestProductionItem({ accountId: account.id, postType: "youtube_long", sourceType: "original" });
    const spoke = await createTestProductionItem({
      accountId: account.id,
      postType: "instagram_reel",
      sourceType: "repurposed",
      pillarContentItemId: hub.id,
    });
    const repost = await createTestProductionItem({ accountId: account.id, sourceType: "repost", repostedFromItemId: hub.id });

    const got = await getContent(hub.id, BASE);
    expect(got.id).toBe(hub.id);
    expect(got.account?.platform).toBe("youtube");

    const spokes = await listDerivatives(hub.id, BASE);
    expect(spokes.data.map((i) => i.id).sort()).toEqual([spoke.id, repost.id].sort());
    expect(spokes.data.find((i) => i.id === spoke.id)?.hub_id).toBe(hub.id);

    const viaFilter = await listContent({ hub_id: hub.id }, BASE);
    expect(viaFilter.data.map((i) => i.id)).toEqual([spoke.id]);
  });

  it("404s for unknown and deleted items", async () => {
    await expect(getContent("00000000-0000-4000-8000-000000000000", BASE)).rejects.toBeInstanceOf(ApiError);
    const deleted = await createTestProductionItem({ deletedAt: new Date() });
    await expect(getContent(deleted.id, BASE)).rejects.toMatchObject({ type: "not_found" });
  });

  it("returns the transcript in JSON and renders text/vtt/srt; 404 when none", async () => {
    const item = await createTestProductionItem({});
    await expect(getTranscript(item.id)).rejects.toMatchObject({ type: "not_found" });
    await createTestTranscript({
      productionItemId: item.id,
      segments: [
        { startSec: 0, endSec: 2.5, text: "Hello there." },
        { startSec: 2.5, endSec: 5, text: "Welcome back." },
      ],
      words: [{ word: "Hello", startSec: 0, endSec: 0.5 }],
    });
    const t = await getTranscript(item.id);
    expect(t.text).toBe("Hello there. Welcome back.");
    expect(t.segments).toHaveLength(2);
    expect(t.words).toBeNull();
    expect((await getTranscript(item.id, { includeWords: true })).words).toEqual([{ word: "Hello", start_sec: 0, end_sec: 0.5 }]);
    expect(renderTranscript(t, "text").body).toBe("Hello there.\nWelcome back.");
    expect(renderTranscript(t, "vtt").body).toContain("00:00:02.500 --> 00:00:05.000\nWelcome back.");
    expect(renderTranscript(t, "srt").contentType).toContain("text/plain");
  });

  it("lists clip ideas with their numbers as numbers", async () => {
    const item = await createTestProductionItem({ postType: "youtube_long" });
    const idea = await createTestClipIdea({ sourceProductionItemId: item.id });
    const out = await listClipIdeas(item.id);
    expect(out.data.map((c) => c.id)).toContain(idea.id);
    const c = out.data.find((x) => x.id === idea.id)!;
    expect(typeof c.start_sec).toBe("number");
    expect(c.content_id).toBe(item.id);
  });
});
