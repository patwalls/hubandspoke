import { describe, it, expect } from "vitest";
import { createTestFormat, createTestLayoutPack } from "@/test/factories";
import { loadPromotedClipFormat } from "@/lib/services/promote-clip-idea";
import { loadLayoutPackRef } from "@/lib/services/layout-pack";

// The registry FK must actually change what Underlord receives: a format
// pointing at a pack gets the canonical apply-by-id instruction spliced
// into its Skill at load time; a format without one is untouched.
describe("descript layout pack → prompt composition", () => {
  it("loadPromotedClipFormat splices the pack instruction into the Skill", async () => {
    const brand = `vitest-brand-${Math.random().toString(36).slice(2, 8)}`;
    const pack = await createTestLayoutPack({ name: "Vitest Reels Pack" });
    const fmt = await createTestFormat({
      brand,
      isClippableFormat: true,
      instructions:
        "## Descript Clip & Pack Info\n\nSet the hook text track to: \"{{hook}}\".",
      descriptLayoutPackId: pack.id,
    });

    const loaded = await loadPromotedClipFormat({
      brand,
      targetFormatName: fmt.name,
    });
    expect(loaded.skill).toContain(`named "Vitest Reels Pack"`);
    expect(loaded.skill).toContain(pack.descriptId);
    expect(loaded.skill).toContain("do NOT stop there");
    // Original Skill content survives below the injected instruction.
    expect(loaded.skill).toContain('Set the hook text track to: "{{hook}}".');
  });

  it("a pack FK alone satisfies requireSkill (empty Skill still yields a usable section)", async () => {
    const brand = `vitest-brand-${Math.random().toString(36).slice(2, 8)}`;
    const pack = await createTestLayoutPack();
    const fmt = await createTestFormat({
      brand,
      isClippableFormat: true,
      instructions: null,
      descriptLayoutPackId: pack.id,
    });
    const loaded = await loadPromotedClipFormat({
      brand,
      targetFormatName: fmt.name,
    });
    expect(loaded.skill).toContain("## Descript Clip & Pack Info");
    expect(loaded.skill).toContain(pack.descriptId);
  });

  it("no FK → Skill passes through unchanged", async () => {
    const brand = `vitest-brand-${Math.random().toString(36).slice(2, 8)}`;
    const fmt = await createTestFormat({
      brand,
      isClippableFormat: true,
      instructions: "## Descript Clip & Pack Info\n\nJust the prose.",
    });
    const loaded = await loadPromotedClipFormat({
      brand,
      targetFormatName: fmt.name,
    });
    expect(loaded.skill).toBe("## Descript Clip & Pack Info\n\nJust the prose.");
  });

  it("loadLayoutPackRef round-trips null and real ids", async () => {
    expect(await loadLayoutPackRef(null)).toBeNull();
    const pack = await createTestLayoutPack({ name: "RT Pack" });
    expect(await loadLayoutPackRef(pack.id)).toEqual({
      name: "RT Pack",
      descriptId: pack.descriptId,
      pageUrl: null,
    });
  });
});
