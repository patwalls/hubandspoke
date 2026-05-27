import { describe, it, expect } from "vitest";
import { buildForkUserText } from "./draft-skill-prompt";

const PARENT_SKILL = `## What this format is
A vertical 30-60s Reel repackaging one section with a hook overlay.

## Clip Idea Generation
- **Hook style.** Narrator overlay teasing the payoff.`;

describe("buildForkUserText", () => {
  it("embeds the parent Skill, item content, and the narrow instruction", () => {
    const text = buildForkUserText({
      brand: "starter-story",
      parentFormatName: "Repackage Section w/ Hook",
      parentInstructions: PARENT_SKILL,
      newName: "Reel: Tech-Stack Walkthrough",
      steeringNote: "Only videos where the founder walks through their stack.",
      item: {
        title: "I laughed when he showed me his app",
        postType: "instagram_reel",
        format: "Repackage Section w/ Hook",
        contentBody: "Lucas built a countdown timer and now makes $25K/month.",
      },
    });

    // Parent skill carried through verbatim as the starting point.
    expect(text).toContain("A vertical 30-60s Reel repackaging one section");
    expect(text).toContain('Parent format being forked: "Repackage Section w/ Hook"');
    // The operator's chosen name is fed to the prompt.
    expect(text).toContain("Reel: Tech-Stack Walkthrough");
    // Steering note appears.
    expect(text).toContain("walks through their stack");
    // Item content grounds the narrowing.
    expect(text).toContain("I laughed when he showed me his app");
    expect(text).toContain("countdown timer and now makes $25K/month");
    expect(text).toContain("instagram_reel");
    // The defining instruction: specialize, don't rewrite; narrow, don't broaden.
    expect(text).toContain("FORK");
    expect(text).toMatch(/NARROW/);
    expect(text).toContain("do not broaden the scope");
  });

  it("tolerates a blank steering note and falls back to inferring from content", () => {
    const text = buildForkUserText({
      brand: "starter-story",
      parentFormatName: "Repackage Section w/ Hook",
      parentInstructions: PARENT_SKILL,
      newName: "Reel: Quiet Variant",
      steeringNote: "   ",
      item: {
        title: "A title",
        postType: "instagram_reel",
        format: "Repackage Section w/ Hook",
        contentBody: "Some body.",
      },
    });

    expect(text).toContain("None given");
    // Still narrows.
    expect(text).toMatch(/NARROW/);
  });

  it("handles a parent with no Skill and no item context", () => {
    const text = buildForkUserText({
      brand: "starter-story",
      parentFormatName: "Bare Parent",
      parentInstructions: null,
      newName: "Bare Child",
      steeringNote: "Make it about onboarding clips.",
      item: null,
    });

    expect(text).toContain("The parent has no Skill recorded yet");
    expect(text).toContain("onboarding clips");
    // No item block when none is supplied.
    expect(text).not.toContain("Example piece of content");
  });
});
