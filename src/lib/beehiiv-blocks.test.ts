import { describe, expect, it } from "vitest";
import { layoutSection, markdownToBlocks, splitStepTitles } from "./beehiiv-blocks";

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

describe("layoutSection (the Kevin/Saj template's bullets and arrows)", () => {
  it("'lines': ✅ bullets become one paragraph, one item per line", () => {
    const md = "### Why Claude Works\n\nA benefit line.\n\n- ✅ **Builds** frames\n- ✅ **Syncs** voice";
    const blocks = markdownToBlocks(layoutSection(md, "lines"));
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "paragraph"]);
    expect((blocks[2].formattedText as { text: string }[]).map((r) => r.text).join("")).toBe("✅ Builds frames\n✅ Syncs voice");
  });

  it("'lines' also joins ✅ lines written without a dash", () => {
    const blocks = markdownToBlocks(layoutSection("✅ **A** one\n✅ **B** two", "lines"));
    expect(blocks).toHaveLength(1);
  });

  it("'paragraphs': each bullet is its own paragraph, no list", () => {
    const blocks = markdownToBlocks(layoutSection("Who else this fits.\n\n- **Sales:** follow-ups\n- **Ops:** updates", "paragraphs"));
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(blocks[1]).toMatchObject({ formattedText: [{ text: "Sales:", styling: ["bold"] }, { text: " follow-ups" }] });
  });

  it("keeps the '- Kevin' sign-off and leaves 'list' sections alone", () => {
    expect(layoutSection("Hi.\n\n- Kevin", "paragraphs")).toBe("Hi.\n\n- Kevin");
    expect(layoutSection("- a\n- b", "list")).toBe("- a\n- b");
  });

  it("puts the arrow after the link, and a link-only line with an arrow is still a centered button", () => {
    expect(layoutSection("[See the bundle ->](https://x.co)")).toBe("[See the bundle](https://x.co) →");
    expect(layoutSection("[Watch The Full Video](https://y.co) ->")).toBe("[Watch The Full Video](https://y.co) →");
    const [b] = markdownToBlocks(layoutSection("[Watch The Full Video ->](https://y.co)"), { buttons: true });
    expect(b).toMatchObject({ type: "button", text: "Watch The Full Video →", alignment: "center" });
  });
});
