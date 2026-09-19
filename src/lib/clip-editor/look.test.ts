import { describe, expect, it } from "vitest";
import { applyLook, clipLookSchema, createDefaultDoc, lookFromDoc, type CaptionsLayer } from "./doc";

describe("clip look (a format's template for new edits)", () => {
  it("captures the style half of a doc and applies it to another clip without touching the cut or the hook text", () => {
    const styled = createDefaultDoc({ startSec: 10, endSec: 40, hook: "A styled clip" });
    styled.canvas.background = "#101010";
    styled.video = { ...styled.video, fit: "contain", scalePct: 90, radiusPct: 6 };
    const caps = styled.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
    caps.style = { ...caps.style, fontId: "bangers", color: "#FFE14D" };
    caps.maxWordsPerCue = 2;
    const look = lookFromDoc(styled);
    expect(clipLookSchema.safeParse(JSON.parse(JSON.stringify(look))).success).toBe(true);
    expect(look).not.toHaveProperty("sections");

    const fresh = createDefaultDoc({ startSec: 100, endSec: 130, hook: "A completely different and much longer hook for the next clip idea" });
    const out = applyLook(fresh, look);
    expect(out.sections).toEqual(fresh.sections);
    expect(out.canvas.background).toBe("#101010");
    expect(out.video).toEqual(styled.video);
    const outCaps = out.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
    expect(outCaps.style.fontId).toBe("bangers");
    expect(outCaps.maxWordsPerCue).toBe(2);
    const hook = out.layers.find((l) => l.type === "text" && l.role === "hook");
    expect(hook && hook.type === "text" ? hook.text : null).toBe("A completely different and much longer hook for the next clip idea");
    // The look's hook size is a ceiling; a longer hook is fitted down, never up.
    expect(hook && hook.type === "text" ? hook.style.sizePct : 99).toBeLessThanOrEqual(look.layers.find((l) => l.type === "text")!.type === "text" ? (look.layers.find((l) => l.type === "text") as { style: { sizePct: number } }).style.sizePct : 0);
  });
});
