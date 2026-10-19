import { describe, it, expect } from "vitest";
import { createDefaultDoc } from "./doc";
import { correctPhrase, countMatches, type ShownWord } from "./word-correct";

const shown = (texts: string[]): ShownWord[] =>
  texts.map((text, i) => ({ word: { index: i, text, startSec: i, endSec: i + 0.8 }, text, block: "main" }));
const doc = createDefaultDoc({ startSec: 0, endSec: 20, hook: "" });
const all = { all: true };

describe("correct all — one word", () => {
  const words = shown(["Hand", "off", "to", "Cloud", "Code.", "cloud,", "Cloudy", "Cloud"]);

  it("respells every match, ignoring case and keeping each one's punctuation", () => {
    const d = correctPhrase(doc, words, [words[3]], "Claude", all);
    expect(d.wordEdits).toEqual({ "3000": "Claude", "5000": "Claude,", "7000": "Claude" });
  });

  it("only matches whole words", () => {
    expect(correctPhrase(doc, words, [words[3]], "Claude", all).wordEdits["6000"]).toBeUndefined();
    expect(countMatches(words, [words[3]])).toBe(3);
  });

  it("the word you edited gets exactly what you typed", () => {
    expect(correctPhrase(doc, words, [words[5]], "Claude!", all).wordEdits["5000"]).toBe("Claude!");
  });

  it("setting a word back to what was transcribed drops the correction", () => {
    const fixed = correctPhrase(doc, words, [words[3]], "Claude", all);
    const now = words.map((w) => ({ ...w, text: fixed.wordEdits[String(w.word.startSec * 1000)] ?? w.text }));
    // "Cloud" ×2 are back to the original; "cloud," keeps the new capital.
    expect(correctPhrase(fixed, now, [now[3]], "Cloud", all).wordEdits).toEqual({ "5000": "Cloud," });
  });

  it("ignores an empty replacement", () => {
    expect(correctPhrase(doc, words, [words[3]], "  ", all)).toBe(doc);
  });
});

describe("correct all — a phrase", () => {
  const words = shown(["Hand", "off", "to", "Cloud", "Code.", "The", "cloud", "is", "big.", "Ask", "cloud", "code,", "now", "cloud.", "Code", "rocks"]);
  const phrase = [words[3], words[4]];

  it("fixes only the phrase — a 'cloud' said on its own is left alone", () => {
    const d = correctPhrase(doc, words, phrase, "Claude Code.", all);
    // "Code." at 4 already says that — no correction needed there.
    expect(d.wordEdits).toEqual({ "3000": "Claude", "10000": "Claude", "11000": "Code," });
    expect(d.wordEdits["6000"]).toBeUndefined();
  });

  it("doesn't read across a sentence break", () => {
    // "cloud. Code" at 13–14
    expect(countMatches(words, phrase)).toBe(2);
  });

  it("only this one, when not 'all'", () => {
    expect(correctPhrase(doc, words, phrase, "Claude Code.", { all: false }).wordEdits).toEqual({ "3000": "Claude" });
  });

  it("fewer words than the phrase: the rest go empty, punctuation stays on the last word that says something", () => {
    const w = shown(["Chat", "GPT,", "and", "chat", "GPT"]);
    const d = correctPhrase(doc, w, [w[3], w[4]], "ChatGPT", all);
    expect(d.wordEdits).toEqual({ "0": "ChatGPT,", "1000": "", "3000": "ChatGPT", "4000": "" });
  });

  it("still finds the others after this one was already fixed by hand", () => {
    // "Cloud" at 3 was corrected to "Claude" on its own first.
    const now = words.map((w, i) => (i === 3 ? { ...w, text: "Claude" } : w));
    const run = [now[3], now[4]];
    expect(countMatches(now, run)).toBe(2);
    const d = correctPhrase({ ...doc, wordEdits: { "3000": "Claude" } }, now, run, "Claude Code.", all);
    expect(d.wordEdits).toEqual({ "3000": "Claude", "10000": "Claude", "11000": "Code," });
  });

  it("never joins words from different blocks (a moved or copied scene)", () => {
    const w = shown(["Cloud", "Code"]);
    w[1] = { ...w[1], block: "sec-copy" };
    expect(countMatches(w, [w[0], w[1]])).toBe(0);
  });
});
