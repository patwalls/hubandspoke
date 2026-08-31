import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestAccount,
  createTestFormat,
  createTestFormatChannel,
  createTestFormatTriggerSource,
  createTestProductionItem,
} from "@/test/factories";
import { selectAutoClipIdeaJobs } from "./clip-ideas-auto";

const DAYS = 24 * 3600_000;
const recent = () => new Date(Date.now() - 1 * DAYS);

const savedEnv = process.env.AUTO_CLIP_IDEAS_BRANDS;
beforeEach(() => {
  delete process.env.AUTO_CLIP_IDEAS_BRANDS;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.AUTO_CLIP_IDEAS_BRANDS;
  else process.env.AUTO_CLIP_IDEAS_BRANDS = savedEnv;
});

describe("selectAutoClipIdeaJobs — account-aware routing", () => {
  it("fans out a derivative clippable format wired to the pillar's source account", async () => {
    const account = await createTestAccount({ platform: "youtube" });
    // Root pillar format carries the source channel; the clippable derivative
    // routes through its parent's channels.
    const parent = await createTestFormat({});
    await createTestFormatChannel({
      formatId: parent.id,
      accountId: account.id,
      postType: "youtube_long",
    });
    const clip = await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
    });
    const pillar = await createTestProductionItem({
      accountId: account.id,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.jobs.map((j) => j.targetFormatId)).toContain(clip.id);
    }
  });

  it("does NOT fan out a clippable format wired to a SIBLING account on the same brand (Howfinity → Futurepedia regression)", async () => {
    // Two YouTube channels under the same brand. The clippable format is wired
    // (via its parent's channels) to ONLY the first account.
    const futurepedia = await createTestAccount({
      platform: "youtube",
      handle: `fp-${randomUUID().slice(0, 6)}`,
    });
    const howfinity = await createTestAccount({
      platform: "youtube",
      handle: `hf-${randomUUID().slice(0, 6)}`,
    });
    const parent = await createTestFormat({});
    await createTestFormatChannel({
      formatId: parent.id,
      accountId: futurepedia.id,
      postType: "youtube_long",
    });
    await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
    });

    // Pillar published from the SIBLING (Howfinity) account.
    const pillar = await createTestProductionItem({
      accountId: howfinity.id,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result).toMatchObject({
      eligible: false,
      reason: "no-clippable-formats-for-account",
    });
  });

  it("respects the parent channel's post_type constraint", async () => {
    // Parent channel pins the source to a DIFFERENT post_type than the pillar,
    // so the derivative must not route even though the account matches.
    const account = await createTestAccount({ platform: "youtube" });
    const parent = await createTestFormat({});
    await createTestFormatChannel({
      formatId: parent.id,
      accountId: account.id,
      postType: "youtube_short",
    });
    await createTestFormat({
      parentFormatId: parent.id,
      isClippableFormat: true,
    });
    const pillar = await createTestProductionItem({
      accountId: account.id,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    expect(await selectAutoClipIdeaJobs(pillar.id)).toMatchObject({
      eligible: false,
      reason: "no-clippable-formats-for-account",
    });
  });

  it("routes a ROOT clippable format via format_trigger_sources", async () => {
    const account = await createTestAccount({ platform: "youtube" });
    const rootClip = await createTestFormat({ isClippableFormat: true });
    await createTestFormatTriggerSource({
      formatId: rootClip.id,
      sourceAccountId: account.id,
    });
    const pillar = await createTestProductionItem({
      accountId: account.id,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.jobs.map((j) => j.targetFormatId)).toContain(rootClip.id);
    }
  });

  it("falls back to a brand-wide fan-out for an accountless item (uploaded source_recording)", async () => {
    // No account = no channel to route by; the upload itself is the intent.
    const brand = `vitest-brand-${randomUUID().slice(0, 8)}`;
    const fmt = await createTestFormat({ brand, isClippableFormat: true });
    const pillar = await createTestProductionItem({
      brand,
      accountId: null,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.jobs.map((j) => j.targetFormatId)).toEqual([fmt.id]);
    }
  });
});

describe("selectAutoClipIdeaJobs — gates", () => {
  it("returns the gate reason for an ineligible item", async () => {
    const pillar = await createTestProductionItem({
      accountId: null,
      brand: "starter-story",
      postType: "youtube_shorts",
      sourceType: "original",
      publishedAt: recent(),
    });

    const result = await selectAutoClipIdeaJobs(pillar.id);
    expect(result).toMatchObject({
      eligible: false,
      reason: "post-type-youtube_shorts",
    });
  });

  it("still honors an explicit AUTO_CLIP_IDEAS_BRANDS allowlist over the formats-derived gate", async () => {
    const brand = `vitest-brand-${randomUUID().slice(0, 8)}`;
    await createTestFormat({ brand, isClippableFormat: true });
    const pillar = await createTestProductionItem({
      brand,
      accountId: null,
      postType: "youtube_long",
      sourceType: "original",
      publishedAt: recent(),
    });

    process.env.AUTO_CLIP_IDEAS_BRANDS = "starter-story";
    expect(await selectAutoClipIdeaJobs(pillar.id)).toMatchObject({
      eligible: false,
      reason: `brand-not-auto-enabled-${brand}`,
    });
  });
});
