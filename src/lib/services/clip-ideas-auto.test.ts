import { describe, it, expect, afterEach } from "vitest";
import { evaluateAutoClipIdeaGates, type AutoClipIdeaGateInput } from "./clip-ideas-auto";

const NOW = new Date("2026-06-09T18:00:00Z");
const DAYS = 24 * 3600_000;

function item(overrides: Partial<AutoClipIdeaGateInput> = {}): AutoClipIdeaGateInput {
  return {
    brand: "starter-story",
    status: "Published",
    postType: "youtube_long",
    sourceType: "original",
    publishedAt: new Date(NOW.getTime() - 1 * DAYS),
    publishedDate: null,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.AUTO_CLIP_IDEAS_BRANDS;
  delete process.env.AUTO_CLIP_IDEAS_MAX_AGE_DAYS;
});

describe("evaluateAutoClipIdeaGates", () => {
  it("passes a fresh Published starter-story youtube_long original", () => {
    expect(evaluateAutoClipIdeaGates(item(), NOW)).toEqual({ eligible: true });
  });

  it("passes any brand when AUTO_CLIP_IDEAS_BRANDS is unset (formats-derived gate)", () => {
    // With no env allowlist, the pure gate defers the brand decision to the
    // clippable-formats check in selectAutoClipIdeaJobs — a brand with no
    // clippable formats still gets rejected there.
    expect(evaluateAutoClipIdeaGates(item({ brand: "matg" }), NOW)).toEqual({ eligible: true });
    expect(evaluateAutoClipIdeaGates(item({ brand: "hubspot-brasil" }), NOW)).toEqual({
      eligible: true,
    });
  });

  it("rejects a null brand even without an allowlist", () => {
    const result = evaluateAutoClipIdeaGates(item({ brand: null }), NOW);
    expect(result).toMatchObject({ eligible: false, reason: "brand-not-auto-enabled-null" });
  });

  it("honors the AUTO_CLIP_IDEAS_BRANDS env override as an explicit allowlist", () => {
    process.env.AUTO_CLIP_IDEAS_BRANDS = "matg";
    expect(evaluateAutoClipIdeaGates(item({ brand: "matg" }), NOW)).toEqual({ eligible: true });
    expect(evaluateAutoClipIdeaGates(item(), NOW)).toMatchObject({
      eligible: false,
      reason: "brand-not-auto-enabled-starter-story",
    });
  });

  it("treats an explicitly empty AUTO_CLIP_IDEAS_BRANDS as a kill switch", () => {
    process.env.AUTO_CLIP_IDEAS_BRANDS = "";
    expect(evaluateAutoClipIdeaGates(item(), NOW)).toMatchObject({ eligible: false });
  });

  it("rejects non-Published items", () => {
    expect(evaluateAutoClipIdeaGates(item({ status: "In Progress" }), NOW)).toMatchObject({
      eligible: false,
      reason: "status-In Progress",
    });
  });

  it("rejects non-original source types", () => {
    expect(evaluateAutoClipIdeaGates(item({ sourceType: "repurposed" }), NOW)).toMatchObject({
      eligible: false,
      reason: "source-type-repurposed",
    });
  });

  it("rejects non-long-form post types", () => {
    expect(evaluateAutoClipIdeaGates(item({ postType: "youtube_shorts" }), NOW)).toMatchObject({
      eligible: false,
      reason: "post-type-youtube_shorts",
    });
  });

  it("rejects items older than the recency cap (whisper-backfill protection)", () => {
    const result = evaluateAutoClipIdeaGates(
      item({ publishedAt: new Date(NOW.getTime() - 8 * DAYS) }),
      NOW,
    );
    expect(result).toMatchObject({ eligible: false });
    expect((result as { reason: string }).reason).toMatch(/^published-too-old-/);
  });

  it("honors the AUTO_CLIP_IDEAS_MAX_AGE_DAYS env override", () => {
    process.env.AUTO_CLIP_IDEAS_MAX_AGE_DAYS = "30";
    const result = evaluateAutoClipIdeaGates(
      item({ publishedAt: new Date(NOW.getTime() - 8 * DAYS) }),
      NOW,
    );
    expect(result).toEqual({ eligible: true });
  });

  it("falls back to publishedDate when publishedAt is null", () => {
    const recent = item({ publishedAt: null, publishedDate: "2026-06-07" });
    expect(evaluateAutoClipIdeaGates(recent, NOW)).toEqual({ eligible: true });

    const old = item({ publishedAt: null, publishedDate: "2026-05-01" });
    expect(evaluateAutoClipIdeaGates(old, NOW)).toMatchObject({ eligible: false });
  });

  it("rejects items with no publish date at all", () => {
    expect(
      evaluateAutoClipIdeaGates(item({ publishedAt: null, publishedDate: null }), NOW),
    ).toMatchObject({ eligible: false, reason: "no-publish-date" });
  });
});
