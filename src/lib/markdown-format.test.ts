import { describe, expect, it } from "vitest";
import { collapseImages, expandImages, toggleInline } from "./markdown-format";

describe("toggleInline", () => {
  it("bolds a selection, keeping the edge spaces a double-click picks up outside the marks", () => {
    const v = "Ship it fast today";
    expect(toggleInline(v, 8, 13, "**")).toEqual({ value: "Ship it **fast** today", start: 10, end: 14 });
  });

  it("unbolds text whose marks sit just outside the selection, or inside it", () => {
    expect(toggleInline("Ship it **fast** today", 10, 14, "**").value).toBe("Ship it fast today");
    expect(toggleInline("Ship it **fast** today", 8, 16, "**").value).toBe("Ship it fast today");
  });

  it("italicizes inside bold without mistaking the bold marks for italic ones", () => {
    const bold = "a **word** b";
    expect(toggleInline(bold, 4, 8, "*").value).toBe("a ***word*** b");
    expect(toggleInline("a *word* b", 3, 7, "*").value).toBe("a word b");
  });

  it("does nothing on an empty or blank selection", () => {
    expect(toggleInline("a b", 1, 2, "**").value).toBe("a b");
  });
});

describe("collapseImages / expandImages", () => {
  it("shows images as short tokens while typing and restores them exactly", () => {
    const md = "## Title\n![Claude's dashboard](https://img.youtube.com/vi/x/maxresdefault.jpg)\nOne line.";
    const tokens = new Map<string, string>();
    const text = collapseImages(md, tokens);
    expect(text).toBe("## Title\n[🖼 Claude's dashboard]\nOne line.");
    expect(expandImages(`${text} More.`, tokens)).toBe(`${md} More.`);
  });

  it("keeps tokens stable across edits (no renumbering under the cursor) and drops a deleted image", () => {
    const md = "![a](https://x/1.png)\n![a](https://x/2.png)";
    const tokens = new Map<string, string>();
    expect(collapseImages(md, tokens)).toBe("[🖼 a]\n[🖼 a 2]");
    const edited = expandImages("[🖼 a 2]", tokens);
    expect(edited).toBe("![a](https://x/2.png)");
    expect(collapseImages(edited, tokens)).toBe("[🖼 a 2]");
  });
});
