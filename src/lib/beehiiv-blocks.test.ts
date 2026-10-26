import { describe, expect, it } from "vitest";
import { flattenBullets, keepSignoff, layoutSection, splitStepTitles } from "./beehiiv-blocks";

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
});

describe("layoutSection (the Kevin/Saj template's bullets and arrows)", () => {
  it("'lines': ✅ bullets become one tight group, a hard line break between items", () => {
    const md = "### Why Claude Works\n\nA benefit line.\n\n- ✅ **Builds** frames\n- ✅ **Syncs** voice\n- ✅ **Fixes** colors";
    expect(layoutSection(md, "lines")).toBe("### Why Claude Works\n\nA benefit line.\n\n✅ **Builds** frames  \n✅ **Syncs** voice  \n✅ **Fixes** colors");
  });

  it("'lines' also joins ✅ lines written without a dash", () => {
    expect(flattenBullets("✅ **A** one\n✅ **B** two", "lines")).toBe("✅ **A** one  \n✅ **B** two");
  });

  it("'paragraphs': each bullet is its own paragraph, no list", () => {
    expect(layoutSection("Who else this fits.\n\n- **Sales:** follow-ups\n- **Ops:** updates", "paragraphs")).toBe("Who else this fits.\n\n**Sales:** follow-ups\n\n**Ops:** updates");
  });

  it("keeps the '- Kevin' sign-off and leaves 'list' sections alone", () => {
    expect(layoutSection("Hi.\n\n- Kevin", "paragraphs")).toBe("Hi.\n\n- Kevin");
    expect(layoutSection("- a\n- b", "list")).toBe("- a\n- b");
    expect(keepSignoff("Hi.\n\n- Kevin")).toBe("Hi.\n\n\\- Kevin");
  });

  it("puts the arrow after the link", () => {
    expect(layoutSection("[See the bundle ->](https://x.co)")).toBe("[See the bundle](https://x.co) →");
    expect(layoutSection("[Watch The Full Video](https://y.co) ->")).toBe("[Watch The Full Video](https://y.co) →");
  });
});
