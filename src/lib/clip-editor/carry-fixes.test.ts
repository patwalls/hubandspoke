import { describe, it, expect } from "vitest";
import { createDefaultDoc, type ClipEditDoc } from "./doc";
import { carrySiblingFixes } from "./carry-fixes";
import type { EditorWord } from "./words";

// One source transcript, one word per second: words 0–9 are the first clip's
// section, 10–19 the new clip's.
const said = [
  "we", "use", "chat", "gpt", "and", "rourke", "daily.", "so", "it", "works",
  "then", "chat", "GPT,", "and", "rourke.", "said", "so", "cloud", "is", "fine",
];
const words: EditorWord[] = said.map((text, i) => ({ index: i, text, startSec: i, endSec: i + 0.8 }));
const sibling = (wordEdits: Record<string, string>): ClipEditDoc => ({
  ...createDefaultDoc({ startSec: 0, endSec: 10, hook: "" }),
  wordEdits,
});
const fresh = createDefaultDoc({ startSec: 10, endSec: 20, hook: "" });

describe("carrySiblingFixes", () => {
  it("applies another clip's fixes wherever this video says the same thing, keeping punctuation", () => {
    const { doc, carried } = carrySiblingFixes(fresh, words, [
      sibling({ "2000": "ChatGPT", "3000": "", "5000": "Rork" }),
    ]);
    expect(doc.wordEdits["11000"]).toBe("ChatGPT,");
    expect(doc.wordEdits["12000"]).toBe("");
    expect(doc.wordEdits["14000"]).toBe("Rork.");
    expect(carried.sort()).toEqual(["ChatGPT", "Rork"]);
  });

  it("matches a phrase fix only as that phrase", () => {
    const words2 = [...words, { index: 20, text: "chat", startSec: 20, endSec: 20.8 }];
    const doc = carrySiblingFixes(fresh, words2, [sibling({ "2000": "ChatGPT", "3000": "" })]).doc;
    expect(doc.wordEdits["20000"]).toBeUndefined();
  });

  it("never carries a case or punctuation tweak", () => {
    const { doc, carried } = carrySiblingFixes(fresh, words, [sibling({ "7000": "So," })]);
    expect(doc.wordEdits).toEqual({});
    expect(carried).toEqual([]);
  });

  it("the newest spelling of the same phrase wins", () => {
    const { doc } = carrySiblingFixes(fresh, words, [
      sibling({ "5000": "Rourk" }),
      sibling({ "5000": "Rork" }),
    ]);
    expect(doc.wordEdits["14000"]).toBe("Rork.");
  });

  it("skips uploaded clips' corrections and keys with no word", () => {
    const { doc, carried } = carrySiblingFixes(fresh, words, [
      sibling({ "media-1@5000": "Rork", "999000": "Nope" }),
    ]);
    expect(doc.wordEdits).toEqual({});
    expect(carried).toEqual([]);
  });

  it("only names fixes that land inside this clip", () => {
    const early = createDefaultDoc({ startSec: 15, endSec: 20, hook: "" });
    const { doc, carried } = carrySiblingFixes(early, words, [sibling({ "5000": "Rork" })]);
    // Applied to the whole transcript (in case the clip is widened)…
    expect(doc.wordEdits["14000"]).toBe("Rork.");
    // …but "Rork" isn't said between 15 s and 20 s.
    expect(carried).toEqual([]);
  });

  // fix-names-once M2: a clip someone already opened.
  it("keeps the clip's own corrections and offers only what it hasn't fixed", () => {
    const worked = { ...fresh, wordEdits: { "14000": "Rourk." } };
    const { doc, carried, added } = carrySiblingFixes(worked, words, [
      sibling({ "2000": "ChatGPT", "3000": "", "5000": "Rork" }),
    ]);
    // Their own spelling of the name stays, and isn't offered.
    expect(doc.wordEdits["14000"]).toBe("Rourk.");
    expect(added["14000"]).toBeUndefined();
    expect(added["11000"]).toBe("ChatGPT,");
    expect(carried).toEqual(["ChatGPT"]);
  });

  it("offers nothing once the clip already has every fix", () => {
    const first = carrySiblingFixes(fresh, words, [sibling({ "5000": "Rork" })]);
    const again = carrySiblingFixes(first.doc, words, [sibling({ "5000": "Rork" })]);
    expect(again.added).toEqual({});
    expect(again.carried).toEqual([]);
    expect(again.doc).toBe(first.doc);
  });
});
