/**
 * Integration tests for `getPromotedClipFormat`. The runtime helper that
 * replaced the old hardcoded `PROMOTED_CLIP_FORMAT_BY_BRAND` map (lived
 * here until the 2026-05-11 sourceType consolidation). It looks up the
 * single format per brand whose `is_clip_descript_format=true` is set
 * — that's where clip-idea generation and the Descript Underlord pipeline
 * land new rows.
 *
 * If this lookup ever silently returns the wrong format, every clip the
 * brand produces lands in the wrong bucket. Worth the few-millisecond
 * round-trip to assert it directly.
 */
import { describe, it, expect } from "vitest";
import { getPromotedClipFormat } from "./promote-clip-idea";
import { createTestFormat } from "@/test/factories";

describe("getPromotedClipFormat", () => {
  it("returns the format name when exactly one format on the brand is flagged", async () => {
    const fmt = await createTestFormat({
      brand: `vitest-brand-${Date.now()}`,
      isClipDescriptFormat: true,
    });
    expect(await getPromotedClipFormat(fmt.brand)).toBe(fmt.name);
  });

  it("returns null when no format on the brand is flagged", async () => {
    // Use a brand that no test or seed could have touched.
    const brand = `vitest-empty-${Date.now().toString(36)}`;
    // Sanity: create an unflagged format on this brand so we're sure the
    // lookup isn't matching by brand alone.
    await createTestFormat({ brand, isClipDescriptFormat: false });
    expect(await getPromotedClipFormat(brand)).toBeNull();
  });

  it("doesn't bleed across brands — flagged matg format isn't returned for starter-story", async () => {
    const matgBrand = `vitest-matg-${Date.now().toString(36)}`;
    const ssBrand = `vitest-ss-${Date.now().toString(36)}`;
    await createTestFormat({
      brand: matgBrand,
      isClipDescriptFormat: true,
    });
    // ssBrand has no flagged format → null
    expect(await getPromotedClipFormat(ssBrand)).toBeNull();
  });
});
