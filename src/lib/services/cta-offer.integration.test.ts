import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, productionItems } from "@/lib/db/schema";
import { createTestFormat, createTestProductionItem } from "@/test/factories";

// The Starter Story path must never be reached for MATG, and MATG must never
// touch the go.starterstory.com short-links API. Both are mocked so a call
// shows up as a sentinel instead of a network request.
const listLeadMagnets = vi.fn();
vi.mock("@/lib/services/starter-story-content", () => ({
  listLeadMagnets: (...a: unknown[]) => listLeadMagnets(...a),
  searchContent: vi.fn(),
}));
const shortLinkCalls = vi.fn();
vi.mock("@/lib/services/short-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/short-links")>();
  const spy = (name: string) => (...a: unknown[]) => {
    shortLinkCalls(name, ...a);
    throw new Error(`short-links.${name} must not be called`);
  };
  return {
    ...actual,
    createShortLink: spy("createShortLink"),
    updateShortLink: spy("updateShortLink"),
    findShortLinksByContent: spy("findShortLinksByContent"),
  };
});

import { resolveCtaOffer } from "./cta-offer";
import { generateTrackedCta, suggestCtaDestination } from "./draft-algorithm/tracked-cta";

const DESCRIPTION =
  "Free guide to automate your Instagram marketing with Muse AI: https://clickhubspot.com/cfmu\nMeta's Muse is a free personal AI agent…";

function fakeClient(input: object) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "t1", name: "return_offer", input }],
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function fakeFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 301,
        headers: { location: "https://offers.hubspot.com/muse-guide?utm_source=youtube&utm_campaign=matg-ep&hsa_cam=7&ref=yt" },
      }),
    )
    .mockResolvedValueOnce(new Response("ok", { status: 200 }));
}

async function matgPillar(opts: { description?: string | null } = {}) {
  return createTestProductionItem({
    brand: "matg",
    accountId: null,
    postType: "youtube_long",
    description: opts.description === undefined ? DESCRIPTION : opts.description,
    youtubeUrl: "https://www.youtube.com/watch?v=abc123",
  });
}

describe("resolveCtaOffer (MATG)", () => {
  let originalFallback: string | null = null;
  beforeEach(async () => {
    listLeadMagnets.mockReset();
    listLeadMagnets.mockRejectedValue(new Error("starter-story path reached"));
    shortLinkCalls.mockReset();
    const [b] = await db
      .select({ u: brands.ctaFallbackUrl })
      .from(brands)
      .where(eq(brands.slug, "matg"));
    originalFallback = b?.u ?? null;
  });
  afterEach(async () => {
    await db
      .update(brands)
      .set({ ctaFallbackUrl: originalFallback })
      .where(eq(brands.slug, "matg"));
  });

  it("applies the one fixed UTM rule to every offer link", async () => {
    // utm_campaign is unique across items — randomize.
    const ctaUtm = `vitest-utm-${randomUUID().slice(0, 8)}`;
    const fmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_video" });
    const pillar = await matgPillar();
    const post = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: fmt.name,
      postType: "x",
      pillarContentItemId: pillar.id,
      utmCampaign: ctaUtm,
    });
    const offer = await resolveCtaOffer({ productionItemId: post.id, channel: "x" });
    const u = new URL(offer!.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      v: "abc123",
      utm_medium: "email-media-newsletter",
      utm_source: "matg",
      utm_campaign: "owned",
      utm_content: "Social",
      utm_term: "x",
      utm_id: ctaUtm,
    });
  });

  it("pillar_offer: resolves the clickhubspot link, strips old tracking, applies the post's UTMs, caches on the pillar", async () => {
    const postUtm = `vitest-utm-${randomUUID().slice(0, 8)}`;
    const fmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_offer" });
    const pillar = await matgPillar();
    const post = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: fmt.name,
      postType: "x",
      pillarContentItemId: pillar.id,
      utmCampaign: postUtm,
    });
    const { client, create } = fakeClient({
      found: true,
      label: "Free guide to automate your Instagram marketing with Muse AI",
      url: "https://clickhubspot.com/cfmu",
    });
    const fetchImpl = fakeFetch();

    const offer = await resolveCtaOffer(
      { productionItemId: post.id, channel: "x" },
      { client, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(offer).toEqual({
      url: `https://offers.hubspot.com/muse-guide?ref=yt&utm_source=matg&utm_medium=email-media-newsletter&utm_campaign=owned&utm_content=Social&utm_term=x&utm_id=${postUtm}`,
      label: "Free guide to automate your Instagram marketing with Muse AI",
      source: "pillar_offer",
    });

    const [cached] = await db
      .select({ url: productionItems.ctaOfferUrl, checked: productionItems.ctaOfferCheckedAt })
      .from(productionItems)
      .where(eq(productionItems.id, pillar.id));
    expect(cached.url).toBe("https://offers.hubspot.com/muse-guide?ref=yt");
    expect(cached.checked).not.toBeNull();

    // Second post on the same pillar: served from cache — no LLM, no fetch.
    const post2 = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: fmt.name,
      postType: "linkedin",
      pillarContentItemId: pillar.id,
    });
    const again = await resolveCtaOffer(
      { productionItemId: post2.id, channel: "linkedin" },
      { client, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(again?.url).toBe("https://offers.hubspot.com/muse-guide?ref=yt&utm_source=matg&utm_medium=email-media-newsletter&utm_campaign=owned&utm_content=Social&utm_term=linkedin");
    expect(create).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the two hops from the first resolve only
  });

  it("pillar_video: links the pillar's YouTube video with UTMs", async () => {
    const fmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_video" });
    const pillar = await matgPillar();
    const post = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: fmt.name,
      postType: "instagram_reel",
      pillarContentItemId: pillar.id,
    });
    const offer = await resolveCtaOffer({ productionItemId: post.id, channel: "instagram" });
    expect(offer).toMatchObject({
      url: "https://www.youtube.com/watch?v=abc123&utm_source=matg&utm_medium=email-media-newsletter&utm_campaign=owned&utm_content=Social&utm_term=instagram",
      source: "pillar_video",
    });
  });

  it("no strategy, or a strategy that finds nothing → the brand fallback; no fallback → null", async () => {
    await db.update(brands).set({ ctaFallbackUrl: "https://offers.hubspot.com/main" }).where(eq(brands.slug, "matg"));
    const plain = await createTestFormat({ brand: "matg" });
    const offerFmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_offer" });
    const pillar = await matgPillar();
    const a = await createTestProductionItem({ brand: "matg", accountId: null, format: plain.name });
    const b = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: offerFmt.name,
      pillarContentItemId: pillar.id,
    });
    const { client } = fakeClient({ found: false });

    expect(await resolveCtaOffer({ productionItemId: a.id, channel: "x" })).toMatchObject({
      url: "https://offers.hubspot.com/main?utm_source=matg&utm_medium=email-media-newsletter&utm_campaign=owned&utm_content=Social&utm_term=x",
      source: "fallback",
    });
    expect(await resolveCtaOffer({ productionItemId: b.id, channel: "x" }, { client })).toMatchObject({
      source: "fallback",
    });

    await db.update(brands).set({ ctaFallbackUrl: null }).where(eq(brands.slug, "matg"));
    expect(await resolveCtaOffer({ productionItemId: a.id, channel: "x" })).toBeNull();
  });

  it("generateTrackedCta for MATG writes the offer CTA without the Starter Story path or a go link", async () => {
    const fmt = await createTestFormat({ brand: "matg", ctaStrategy: "pillar_video" });
    const pillar = await matgPillar();
    const post = await createTestProductionItem({
      brand: "matg",
      accountId: null,
      format: fmt.name,
      postType: "x",
      pillarContentItemId: pillar.id,
    });
    const result = await generateTrackedCta({
      productionItemId: post.id,
      channel: "x",
      utmCampaign: null,
      postBody: "post",
      pillarTitle: null,
      formatInstructions: null,
    });
    expect(result).toMatchObject({
      cta: "Watch the full episode:\nhttps://www.youtube.com/watch?v=abc123&utm_source=matg&utm_medium=email-media-newsletter&utm_campaign=owned&utm_content=Social&utm_term=x",
      slug: null,
    });
    expect(listLeadMagnets).not.toHaveBeenCalled();
    expect(shortLinkCalls).not.toHaveBeenCalled();
  });
});

describe("Starter Story and other brands are unchanged", () => {
  beforeEach(() => {
    listLeadMagnets.mockReset();
    listLeadMagnets.mockRejectedValue(new Error("starter-story path reached"));
  });

  for (const brand of ["starter-story", "futurepedia"]) {
    it(`${brand}: still goes through the Starter Story CTA logic, even with a cta_strategy set`, async () => {
      const fmt = await createTestFormat({ brand, ctaStrategy: "pillar_video" });
      const post = await createTestProductionItem({ brand, accountId: null, format: fmt.name, postType: "x" });
      await expect(
        generateTrackedCta({
          productionItemId: post.id,
          channel: "x",
          utmCampaign: null,
          postBody: "post",
          pillarTitle: null,
          formatInstructions: null,
        }),
      ).rejects.toThrow("starter-story path reached");
      expect(await resolveCtaOffer({ productionItemId: post.id, channel: "x" })).toBeNull();
    });
  }

  it("suggestCtaDestination keeps the Starter Story path for starter-story items", async () => {
    const post = await createTestProductionItem({ brand: "starter-story", accountId: null, postType: "instagram_reel" });
    await expect(suggestCtaDestination({ productionItemId: post.id, channel: "instagram" })).rejects.toThrow(
      "starter-story path reached",
    );
  });
});
