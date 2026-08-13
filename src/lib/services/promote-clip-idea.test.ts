import { describe, it, expect } from "vitest";
import { buildDescriptPrompt } from "./promote-clip-idea";

const BASE_ARGS = {
  skill: "### Descript\nCut the clip.",
  hook: "Work retreats are broken",
  startSec: 173,
  endSec: 267,
  productionItemId: "f87a9100-1b56-4bf4-bf12-5d7dea72c9cf",
  aspectRatio: "9:16" as const,
  quotables: [],
};

describe("buildDescriptPrompt", () => {
  it("uses explicit source composition ID when provided — no ambiguous 'main composition'", () => {
    const prompt = buildDescriptPrompt({
      ...BASE_ARGS,
      sourceCompositionId: "bd1e9d68-a457-4c20-aa58-add3770fb4fa",
    });
    expect(prompt).toContain('compositionId="bd1e9d68-a457-4c20-aa58-add3770fb4fa"');
    expect(prompt).not.toContain("main composition");
    // Explicit read-only instruction prevents Underlord from editing the source
    expect(prompt).toContain("Do NOT edit or trim this source composition");
  });

  it("falls back to 'main composition' when no seed is provided (back-compat)", () => {
    const prompt = buildDescriptPrompt({ ...BASE_ARGS });
    expect(prompt).toContain("main composition");
    expect(prompt).not.toContain("source composition");
  });

  it("falls back to 'main composition' when sourceCompositionId is null", () => {
    const prompt = buildDescriptPrompt({ ...BASE_ARGS, sourceCompositionId: null });
    expect(prompt).toContain("main composition");
  });

  it("two clips from the same pillar get different target composition names in the prompt", () => {
    const clip1 = buildDescriptPrompt({
      ...BASE_ARGS,
      hook: "Work retreats are broken",
      productionItemId: "f87a9100-1b56-4bf4-bf12-5d7dea72c9cf",
      sourceCompositionId: "seed-composition-uuid",
    });
    const clip2 = buildDescriptPrompt({
      ...BASE_ARGS,
      hook: "Every email strategy is wrong",
      productionItemId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      sourceCompositionId: "seed-composition-uuid",
    });
    // Both reference the SAME source composition — same pillar
    expect(clip1).toContain('compositionId="seed-composition-uuid"');
    expect(clip2).toContain('compositionId="seed-composition-uuid"');
    // But each creates a NEW composition with a different name (hook + itemId)
    expect(clip1).not.toContain("Every email strategy is wrong");
    expect(clip2).not.toContain("Work retreats are broken");
    // Step 2 in each creates a uniquely-named composition
    expect(clip1).toMatch(/Create a NEW composition named "[^"]*f87a9100/);
    expect(clip2).toMatch(/Create a NEW composition named "[^"]*aaaaaaaa/);
  });
});
