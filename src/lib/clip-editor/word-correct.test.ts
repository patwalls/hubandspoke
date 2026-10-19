import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { correctAll, countMatches, type ShownWord } from "./word-correct";

const shown = (texts: string[]): ShownWord[] =>
  texts.map((text, i) => ({ word: { index: i, text, startSec: i, endSec: i + 0.8 }, text }));

describe("correctAll", () => {
  const words = shown(["Hand", "off", "to", "Cloud", "Code.", "cloud,", "Cloudy", "Cloud"]);
  const doc = createDefaultDoc({ startSec: 0, endSec: 10, hook: "" });

  it("respells every match, ignoring case and keeping each one's punctuation", () => {
    const d = correctAll(doc, words, words[3], "Claude");
    expect(d.wordEdits).toEqual({ "3000": "Claude", "5000": "Claude,", "7000": "Claude" });
  });

  it("only matches whole words", () => {
    expect(correctAll(doc, words, words[3], "Claude").wordEdits["6000"]).toBeUndefined();
    expect(countMatches(words, "Cloud")).toBe(3);
  });

  it("the word you edited gets exactly what you typed", () => {
    expect(correctAll(doc, words, words[5], "Claude!").wordEdits["5000"]).toBe("Claude!");
  });

  it("matches words already corrected by their current spelling, and undoes back to the original", () => {
    const fixed = correctAll(doc, words, words[3], "Claude");
    const now = words.map((w) => ({ ...w, text: fixed.wordEdits[String(w.word.startSec * 1000)] ?? w.text }));
    const back = correctAll(fixed, now, now[3], "Cloud");
    // "Cloud" ×2 are back to what was transcribed; "cloud," keeps the new capital.
    expect(back.wordEdits).toEqual({ "5000": "Cloud," });
  });

  it("ignores an empty replacement", () => {
    expect(correctAll(doc, words, words[3], "  ")).toBe(doc);
  });
});
