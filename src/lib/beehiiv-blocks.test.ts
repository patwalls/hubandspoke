import { describe, expect, it } from "vitest";
import { markdownToBlocks, splitStepTitles } from "./beehiiv-blocks";

describe("splitStepTitles", () => {
  it("puts an inline bold step title on its own line, like the Kevin/Saj templates", () => {
    expect(splitStepTitles("**4. Copy the prompt & send it to Claude.** Click 'Copy Prompt', then paste.")).toBe(
      "**4. Copy the prompt & send it to Claude**\nClick 'Copy Prompt', then paste.",
    );
    expect(splitStepTitles("1. **Pick a style:** Open the atlas.")).toBe("**1. Pick a style**\nOpen the atlas.");
  });

  it("leaves titles already on their own line, and ordinary lines, alone", () => {
    const md = "**1. Pick a style in the Style Atlas**\nOpen the free Style Atlas.\nA **bold** word mid-line.";
    expect(splitStepTitles(md)).toBe(md);
  });

  it("makes the title and its explanation separate beehiiv paragraphs", () => {
    const blocks = markdownToBlocks(splitStepTitles("**2. Record your voiceover.** Open Google AI Studio."));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[0]).toMatchObject({ formattedText: [{ text: "2. Record your voiceover", styling: ["bold"] }] });
  });
});
