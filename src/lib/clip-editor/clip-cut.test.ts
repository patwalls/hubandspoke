import { describe, expect, it } from "vitest";
import { clipCutFromDoc, clipCutFromRange } from "./clip-cut";
import { createDefaultDoc } from "./doc";
import { addRemoval } from "./removals";
import type { EditorWord } from "./words";

// One word a second: "w0" at 0–0.8, "w1" at 1–1.8, …
const words: EditorWord[] = Array.from({ length: 40 }, (_, i) => ({
  index: i,
  text: i === 12 ? "twelve." : `w${i}`,
  startSec: i,
  endSec: i + 0.8,
}));

describe("clipCutFromDoc — what the clip actually says", () => {
  it("joins the kept words, drops removed ones, keeps a trimmed word, and separates sections", () => {
    const doc = createDefaultDoc({ startSec: 10, endSec: 15, hook: "h", introRanges: [{ startSec: 30, endSec: 32 }] });
    const body = doc.sections.find((s) => s.role === "body")!;
    // Cut "w11" entirely; shave the end of "twelve." (a trim keeps the word).
    let next = addRemoval(body, { startSec: 11, endSec: 11.8 }, "filler");
    next = addRemoval(next, { startSec: 12.7, endSec: 12.8 }, "trim");
    doc.sections = doc.sections.map((s) => (s.id === body.id ? next : s));

    const cut = clipCutFromDoc(doc, words)!;
    expect(cut.transcript).toBe("w30 w31\n\nw10 twelve. w13 w14");
    expect(cut.startSec).toBe(10);
    expect(cut.endSec).toBe(32);
    expect(cut.durationSec).toBeCloseTo(2 + 5 - 0.8 - 0.1, 5);
  });

  it("falls back to the idea's range when there is no edit", () => {
    const cut = clipCutFromRange({ startSec: 3, endSec: 6 }, words);
    expect(cut.transcript).toBe("w3 w4 w5");
    expect(cut.durationSec).toBe(3);
  });
});
