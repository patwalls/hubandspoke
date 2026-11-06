import { describe, it, expect } from "vitest";
import { clipLookSchema } from "./doc";
import { describeLookSuggestion, lookFromSuggestion } from "./look-from-example";

describe("lookFromSuggestion", () => {
  it("builds a valid horizontal look with a boxed Anton hook and highlighted captions", () => {
    const r = lookFromSuggestion({
      aspectRatio: "16:9",
      hook: { present: true, fontId: "anton", color: "#ffffff", style: "boxed", boxColor: "#ff0000", uppercase: true, position: "top" },
      captions: { present: true, fontId: "inter-bold", color: "#ffffff", style: "outline", highlightColor: "#00ff00", wordsPerCue: 2, position: "bottom" },
    })!;
    expect(r.aspectRatio).toBe("16:9");
    expect(clipLookSchema.safeParse(r.look).success).toBe(true);
    const hook = r.look.layers.find((l) => l.type === "text" && l.role === "hook");
    const caps = r.look.layers.find((l) => l.type === "captions");
    expect(hook?.type === "text" && hook.style.fontId).toBe("anton");
    expect(hook?.type === "text" && hook.style.box?.color).toBe("#FF0000");
    expect(hook?.type === "text" && hook.style.uppercase).toBe(true);
    expect(caps?.type === "captions" && caps.highlightColor).toBe("#00FF00");
    expect(caps?.type === "captions" && caps.maxWordsPerCue).toBe(2);
  });

  it("hides what the examples don't have", () => {
    const r = lookFromSuggestion({ aspectRatio: "9:16", hook: { present: false } })!;
    expect(r.look.layers.find((l) => l.type === "text")?.visible).toBe(false);
    expect(r.look.layers.find((l) => l.type === "captions")?.visible).toBe(true);
  });

  it("rejects a guess outside the editor's fonts or shapes", () => {
    expect(lookFromSuggestion({ aspectRatio: "4:5" })).toBeNull();
    expect(lookFromSuggestion({ aspectRatio: "9:16", hook: { present: true, fontId: "comic-sans" } })).toBeNull();
  });

  it("describes what was matched", () => {
    expect(describeLookSuggestion({ aspectRatio: "16:9", hook: { present: true, style: "outline" } })).toBe("horizontal 16:9 · outline hook");
  });
});
