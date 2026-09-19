import { describe, expect, it } from "vitest";
import { endsClause, endsSentence, needsPunctuation, punctuateWords, stripCaptionPunctuation, wordKey } from "./punctuate-words";

const timed = (spec: string, start = 0) => spec.split(" ").map((word, i) => ({ word, startSec: start + i, endSec: start + i + 0.8 }));

describe("punctuateWords", () => {
  it("copies the segment's punctuation onto the timed words when they line up one to one", () => {
    const words = timed("I stopped guessing what customers wanted then we sold it");
    const segments = [
      { startSec: 0, endSec: 6, text: "I stopped guessing what customers wanted." },
      { startSec: 6, endSec: 10, text: "Then, we sold it!" },
    ];
    const out = punctuateWords(words, segments);
    expect(out.map((w) => w.word)).toEqual(["I", "stopped", "guessing", "what", "customers", "wanted.", "Then,", "we", "sold", "it!"]);
    expect(out.map((w) => w.startSec)).toEqual(words.map((w) => w.startSec)); // timing untouched
    expect(words[5].word).toBe("wanted"); // input not mutated
  });
  it("survives Whisper splitting a token differently between the two outputs", () => {
    const words = timed("we hit 10 k a month okay");
    const segments = [{ startSec: 0, endSec: 8, text: "We hit 10k a month, okay?" }];
    const out = punctuateWords(words, segments);
    expect(out.map((w) => w.word)).toEqual(["We", "hit", "10", "k", "a", "month,", "okay?"]);
  });
  it("leaves words alone when a segment has no text, and handles offsets across chunks", () => {
    const words = timed("hello there", 100);
    expect(punctuateWords(words, [{ startSec: 100, endSec: 103, text: "" }]).map((w) => w.word)).toEqual(["hello", "there"]);
    expect(punctuateWords(words, [{ startSec: 99.5, endSec: 102.5, text: "Hello there." }]).map((w) => w.word)).toEqual(["Hello", "there."]);
  });
  it("helpers", () => {
    expect(wordKey("Wanted.")).toBe("wanted");
    expect(endsSentence("wanted.")).toBe(true);
    expect(endsSentence('okay?"')).toBe(true);
    expect(endsSentence("then,")).toBe(false);
    expect(endsClause("then,")).toBe(true);
    expect(stripCaptionPunctuation("wanted.")).toBe("wanted");
    expect(stripCaptionPunctuation("okay?")).toBe("okay?");
    expect(stripCaptionPunctuation('"quote,"')).toBe("quote");
    expect(needsPunctuation(timed("a b"), [{ startSec: 0, endSec: 2, text: "A b." }])).toBe(true);
    expect(needsPunctuation(timed("a b."), [{ startSec: 0, endSec: 2, text: "A b." }])).toBe(false);
  });
});
