import { describe, it, expect } from "vitest";
import { formatRange, insertRich, isRangeBold, richToSpans, spansToRich, wordRange } from "./rich-text";

describe("rich text (the inline editor's model)", () => {
  it("round-trips spans, merging equal neighbours", () => {
    const spans = [{ text: "now the " }, { text: "$69K", color: "#22E07A" }, { text: " came", bold: true }];
    expect(richToSpans(spansToRich(spans))).toEqual(spans);
    expect(richToSpans(spansToRich([{ text: "a" }, { text: "b" }]))).toEqual([{ text: "ab" }]);
    expect(richToSpans(spansToRich([{ text: "" }]))).toEqual([{ text: "" }]);
  });

  it("formats only the selected copy of a phrase, grown to whole words, and layers colour with bold", () => {
    const rt = spansToRich([{ text: "framer ($200/mo) codex ($200/mo)" }]);
    const bolded = formatRange(rt, 8, 12, { bold: true }); // inside the first "($200/mo)"
    expect(bolded.range).toEqual([7, 16]);
    const coloured = formatRange(bolded.rt, 7, 16, { color: "#FF3B3B" }).rt;
    expect(richToSpans(coloured)).toEqual([
      { text: "framer " },
      { text: "($200/mo)", color: "#FF3B3B", bold: true },
      { text: " codex ($200/mo)" },
    ]);
  });

  it("grows a selection (or a caret) to whole words", () => {
    expect(wordRange("framer: website", 10, 12)).toEqual([8, 15]);
    expect(wordRange("framer: website", 3, 3)).toEqual([0, 7]);
    expect(wordRange("framer: website", 0, 15)).toEqual([0, 15]);
    expect(wordRange("a  b", 2, 2)).toEqual([2, 2]); // caret between spaces: nothing
  });

  it("B toggles off only when every letter is already bold", () => {
    const rt = formatRange(spansToRich([{ text: "one two" }]), 0, 3, { bold: true }).rt;
    expect(isRangeBold(rt, 0, 3)).toBe(true);
    expect(isRangeBold(rt, 0, 7)).toBe(false);
  });

  it("typed text takes the style of the character before it", () => {
    const rt = formatRange(spansToRich([{ text: "a bb" }]), 2, 4, { bold: true }).rt;
    expect(richToSpans(insertRich(rt, 4, 4, "b!"))).toEqual([{ text: "a " }, { text: "bbb!", bold: true }]);
    expect(richToSpans(insertRich(rt, 0, 0, "x"))).toEqual([{ text: "xa " }, { text: "bb", bold: true }]);
  });
});
