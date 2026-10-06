import { describe, expect, it } from "vitest";
import { applyLook, createDefaultDoc, lookFromDoc, type CaptionsLayer, type TextLayer } from "./doc";
import { SAMPLE_HOOK, SAMPLE_WORDS, buildLookPreviewDoc } from "./look-preview";

const hookOf = (layers: { type: string }[]) => layers.find((l): l is TextLayer => l.type === "text" && (l as TextLayer).role === "hook")!;

describe("editing a format's clip look without a clip", () => {
  const styled = createDefaultDoc({ startSec: 10, endSec: 40, hook: "Short" });
  styled.canvas.background = "#101010";
  styled.video = { ...styled.video, scalePct: 94, radiusPct: 4 };
  hookOf(styled.layers).style = { ...hookOf(styled.layers).style, fontId: "inter-bold", sizePct: 7 };
  const caps = styled.layers.find((l): l is CaptionsLayer => l.type === "captions")!;
  caps.maxWordsPerCue = 6;
  const look = lookFromDoc(styled);

  it("round-trips the look unchanged except the placeholder hook text — the hook size isn't fitted down to the placeholder", () => {
    const back = lookFromDoc(buildLookPreviewDoc(look));
    expect(back.background).toBe(look.background);
    expect(back.video).toEqual(look.video);
    expect(hookOf(back.layers).style).toEqual(hookOf(look.layers).style);
    expect(hookOf(back.layers).text).toBe(SAMPLE_HOOK);
    expect(back.layers.map((l) => l.id)).toEqual(look.layers.map((l) => l.id));
  });

  it("a look saved from the template never puts the placeholder hook into a real clip", () => {
    const saved = lookFromDoc(buildLookPreviewDoc(look));
    const realClip = createDefaultDoc({ startSec: 200, endSec: 230, hook: "The AI hook written for this clip" });
    expect(hookOf(applyLook(realClip, saved).layers).text).toBe("The AI hook written for this clip");
  });

  it("starts from the default layout when the format has no look, with sample words from 0s for the captions", () => {
    const doc = buildLookPreviewDoc(null);
    expect(hookOf(doc.layers).text).toBe(SAMPLE_HOOK);
    expect(doc.layers.some((l) => l.type === "captions")).toBe(true);
    expect(SAMPLE_WORDS[0].startSec).toBe(0);
    expect(doc.sections[0].endSec).toBeCloseTo(SAMPLE_WORDS[SAMPLE_WORDS.length - 1].endSec);
  });
});
