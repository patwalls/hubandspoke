import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";

// Rebrandly is an in-memory fake (links by slashtag) and the Starter Story
// short-links API is mocked: the tests prove which one each brand reaches
// and what every link points at, without network calls.
type FakeLink = { id: string; slashtag: string; shortUrl: string; destination: string; title: string | null; favourite: boolean; clicks: number; lastClickAt: string | null; createdAt: string | null; updatedAt: string | null };
const store = new Map<string, FakeLink>();
const rb = {
  listWorkspaceLinks: vi.fn(async () => [...store.values()]),
  getLinkBySlashtag: vi.fn(async (slashtag: string) => store.get(slashtag.toLowerCase()) ?? null),
  createLink: vi.fn(async (a: { slashtag: string; destination: string; title: string }) => {
    const l = fakeLink(a.slashtag, { destination: a.destination });
    store.set(l.slashtag, l);
    return l;
  }),
  updateLinkDestination: vi.fn(async (l: { id: string }, destination: string) => {
    const hit = [...store.values()].find((x) => x.id === l.id)!;
    hit.destination = destination;
    return hit;
  }),
};
vi.mock("@/lib/services/rebrandly", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/rebrandly")>();
  return {
    ...actual,
    listWorkspaceLinks: () => rb.listWorkspaceLinks(),
    getLinkBySlashtag: (...a: [string]) => rb.getLinkBySlashtag(...a),
    createLink: (...a: [{ slashtag: string; destination: string; title: string }]) => rb.createLink(...a),
    updateLinkDestination: (...a: [{ id: string }, string]) => rb.updateLinkDestination(...a),
  };
});
const shortLinks = { getShortLink: vi.fn(), createShortLink: vi.fn(), updateShortLink: vi.fn(), findShortLinksByContent: vi.fn(), listShortLinks: vi.fn() };
vi.mock("@/lib/services/short-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/short-links")>();
  return {
    ...actual,
    getShortLink: (...a: unknown[]) => shortLinks.getShortLink(...a),
    createShortLink: (...a: unknown[]) => shortLinks.createShortLink(...a),
    updateShortLink: (...a: unknown[]) => shortLinks.updateShortLink(...a),
    findShortLinksByContent: (...a: unknown[]) => shortLinks.findShortLinksByContent(...a),
    listShortLinks: (...a: unknown[]) => shortLinks.listShortLinks(...a),
  };
});

import { attachDmKeyword, ensureDmKeyword, listDmKeywordPool } from "./dm-keyword";
import { perPostDmSlashtag } from "@/lib/cta-offer-brands";

function fakeLink(slashtag: string, extra: Partial<FakeLink> = {}): FakeLink {
  return {
    id: `id-${slashtag}`,
    slashtag,
    shortUrl: `clickhubspot.com/${slashtag}`,
    destination: "https://offers.hubspot.com/placeholder",
    title: slashtag,
    favourite: false,
    clicks: 0,
    lastClickAt: null,
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

async function slugOf(id: string) {
  const [row] = await db.select({ s: productionItems.shortLinkSlug }).from(productionItems).where(eq(productionItems.id, id));
  return row.s;
}

const dest = (slashtag: string) => store.get(slashtag)?.destination;

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(rb)) fn.mockClear();
  for (const fn of Object.values(shortLinks)) fn.mockReset();
  for (const l of [fakeLink("matg-aimarketer"), fakeLink("matg-promptpack", { clicks: 4, lastClickAt: "2026-10-01T00:00:00Z" }), fakeLink("mfm-ideavault")]) store.set(l.slashtag, l);
});

describe("DM keywords on Rebrandly (MATG / MFM)", () => {
  it("attaching builds keyword → the post's own link → offer, and never touches Starter Story's short links", async () => {
    const post = await createTestProductionItem({ brand: "matg", accountId: null, postType: "instagram_reel" });
    const offer = "https://offers.hubspot.com/ai-search-visibility-audit?utm_source=matg&utm_id=a";
    const chain = await attachDmKeyword({ itemId: post.id, keywordSlug: "matg-aimarketer", destinationUrl: offer });
    const own = perPostDmSlashtag("matg", post.id);
    expect(chain.perPostSlug).toBe(own);
    expect(dest(own)).toBe(offer);
    expect(dest("matg-aimarketer")).toBe(`https://clickhubspot.com/${own}`);
    expect(await slugOf(post.id)).toBe("matg-aimarketer");
    for (const fn of Object.values(shortLinks)) expect(fn).not.toHaveBeenCalled();
  });

  it("moving a keyword to a new post leaves the old post's link and UTMs exactly as they were", async () => {
    const a = await createTestProductionItem({ brand: "my-first-million", accountId: null, postType: "instagram_reel" });
    const b = await createTestProductionItem({ brand: "my-first-million", accountId: null, postType: "instagram_reel" });
    await attachDmKeyword({ itemId: a.id, keywordSlug: "mfm-ideavault", destinationUrl: "https://offers.hubspot.com/x?utm_id=post-a" });
    await attachDmKeyword({ itemId: b.id, keywordSlug: "mfm-ideavault", destinationUrl: "https://offers.hubspot.com/y?utm_id=post-b" });
    expect(dest(perPostDmSlashtag("my-first-million", a.id))).toBe("https://offers.hubspot.com/x?utm_id=post-a");
    expect(dest(perPostDmSlashtag("my-first-million", b.id))).toBe("https://offers.hubspot.com/y?utm_id=post-b");
    expect(dest("mfm-ideavault")).toBe(`https://clickhubspot.com/${perPostDmSlashtag("my-first-million", b.id)}`);
    // Re-attaching reuses the post's own link instead of making another.
    await attachDmKeyword({ itemId: b.id, keywordSlug: "mfm-ideavault", destinationUrl: "https://offers.hubspot.com/y?utm_id=post-b" });
    expect(rb.createLink).toHaveBeenCalledTimes(2);
  });

  it("rejects another brand's keyword and per-post links", async () => {
    const post = await createTestProductionItem({ brand: "matg", accountId: null, postType: "instagram_reel" });
    await expect(attachDmKeyword({ itemId: post.id, keywordSlug: "mfm-ideavault", destinationUrl: "https://offers.hubspot.com/x" })).rejects.toMatchObject({ status: 400 });
    await expect(attachDmKeyword({ itemId: post.id, keywordSlug: "matg-p-12345678", destinationUrl: "https://offers.hubspot.com/x" })).rejects.toMatchObject({ status: 400 });
    expect(rb.updateLinkDestination).not.toHaveBeenCalled();
  });

  it("the pool lists only the brand's keywords, shows where commenters land, and returns this post's own link", async () => {
    const post = await createTestProductionItem({ brand: "matg", accountId: null, postType: "instagram_reel" });
    await attachDmKeyword({ itemId: post.id, keywordSlug: "matg-promptpack", destinationUrl: "https://offers.hubspot.com/final?utm_id=z" });
    const { shortLinks: pool, postLink } = await listDmKeywordPool("matg", { itemId: post.id });
    expect(pool.map((p) => p.slug).sort()).toEqual(["matg-aimarketer", "matg-promptpack"]);
    const pp = pool.find((p) => p.slug === "matg-promptpack")!;
    expect(pp).toMatchObject({ clicksCount: 4, tag: "dm", destinationUrl: "https://offers.hubspot.com/final?utm_id=z" });
    expect(pp.inUseCount).toBeGreaterThanOrEqual(1);
    expect(postLink).toMatchObject({ slug: perPostDmSlashtag("matg", post.id), destinationUrl: "https://offers.hubspot.com/final?utm_id=z" });
  });

  it("ensureDmKeyword gives a MATG post its brand's best free keyword, through the post's own link", async () => {
    const fmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_video" });
    const pillar = await createTestProductionItem({ brand: "matg", accountId: null, postType: "youtube_long", youtubeUrl: "https://www.youtube.com/watch?v=pv1" });
    const post = await createTestProductionItem({ brand: "matg", accountId: null, format: fmt.name, postType: "instagram_post", pillarContentItemId: pillar.id });
    // A leftover Starter Story keyword on the post doesn't count as attached.
    await db.update(productionItems).set({ shortLinkSlug: "playbook" }).where(eq(productionItems.id, post.id));

    const slug = await ensureDmKeyword(post.id);
    expect(slug?.startsWith("matg-")).toBe(true);
    const own = dest(perPostDmSlashtag("matg", post.id))!;
    expect(own).toContain("https://www.youtube.com/watch?v=pv1");
    expect(own).toContain("utm_source=matg");
    expect(own).toContain("utm_term=instagram");
    expect(await slugOf(post.id)).toBe(slug);
    expect(shortLinks.listShortLinks).not.toHaveBeenCalled();
  });
});

describe("Starter Story DM keywords are unchanged", () => {
  it("attaching still builds the go.starterstory.com chain and never calls Rebrandly", async () => {
    const post = await createTestProductionItem({ brand: "starter-story", accountId: null, postType: "instagram_reel" });
    shortLinks.findShortLinksByContent.mockResolvedValue([]);
    shortLinks.createShortLink.mockResolvedValue({});
    shortLinks.getShortLink.mockResolvedValue({ slug: "playbook" });
    shortLinks.updateShortLink.mockResolvedValue({});
    const chain = await attachDmKeyword({ itemId: post.id, keywordSlug: "playbook", destinationUrl: "https://starterstory.com/x" });
    expect(chain.perPostGoUrl).toMatch(/\/cta-[0-9a-f]{8}$/);
    expect(shortLinks.updateShortLink).toHaveBeenCalledWith("playbook", expect.objectContaining({ tag: "dm" }));
    for (const fn of Object.values(rb)) expect(fn).not.toHaveBeenCalled();
    expect(await slugOf(post.id)).toBe("playbook");
  });
});
