import { describe, it, expect } from "vitest";
import { createDefaultDoc, type ClipEditDoc } from "./doc";
import { brandSpellingDocs, carrySiblingFixes, learnBrandSpellings } from "./carry-fixes";
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

// fix-names-once M3: names fixed in clips of 2+ different videos of a brand.
describe("brand spellings", () => {
  const video = (texts: string[]): EditorWord[] =>
    texts.map((text, i) => ({ index: i, text, startSec: i, endSec: i + 0.8 }));
  const a = video(["we", "use", "cloud", "daily"]);
  const b = video(["i", "asked", "cloud,", "then", "chat", "gpt"]);
  const c = video(["chat", "gpt", "is", "great"]);
  const fixDoc = (wordEdits: Record<string, string>) => ({ ...fresh, wordEdits });

  it("learns a name only once it was fixed in two different videos", () => {
    const spellings = learnBrandSpellings([
      { sourceId: "A", doc: fixDoc({ "2000": "Claude" }), words: a },
      { sourceId: "A", doc: fixDoc({ "2000": "Claude" }), words: a },
      { sourceId: "B", doc: fixDoc({ "2000": "Claude,", "4000": "ChatGPT", "5000": "" }), words: b },
    ]);
    // "Claude": videos A and B. "ChatGPT": only video B (two clips of one video don't count).
    expect(spellings).toEqual([{ said: "cloud", replacement: "Claude", videos: 2 }]);
  });

  it("never learns a case or punctuation tweak", () => {
    const spellings = learnBrandSpellings([
      { sourceId: "A", doc: fixDoc({ "0": "We," }), words: a },
      { sourceId: "B", doc: fixDoc({ "0": "I," }), words: b },
    ]);
    expect(spellings).toEqual([]);
  });

  it("offers a brand spelling everywhere this video says it, keeping each spot's punctuation", () => {
    const here = video(["so", "chat", "gpt.", "and", "cloud", "and", "chat", "gpt"]);
    const docs = brandSpellingDocs(
      [
        { said: "chat gpt", replacement: "ChatGPT", videos: 2 },
        { said: "rourke", replacement: "Rork", videos: 3 }, // never said here
      ],
      here,
      fresh,
    );
    expect(docs).toHaveLength(1);
    const clip = createDefaultDoc({ startSec: 0, endSec: 8, hook: "" });
    const { added, carried } = carrySiblingFixes(clip, here, docs);
    expect(added).toEqual({ "1000": "ChatGPT.", "2000": "", "6000": "ChatGPT", "7000": "" });
    expect(carried).toEqual(["ChatGPT"]);
  });

  it("a clip's own spelling of the name wins over the brand's", () => {
    const here = video(["cloud", "and", "cloud"]);
    const docs = brandSpellingDocs([{ said: "cloud", replacement: "Claude", videos: 2 }], here, fresh);
    const own = { ...createDefaultDoc({ startSec: 0, endSec: 3, hook: "" }), wordEdits: { "0": "Klaud" } };
    const { added } = carrySiblingFixes(own, here, docs);
    expect(added["0"]).toBeUndefined();
    expect(added["2000"]).toBe("Claude");
  });
});
