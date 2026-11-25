import { describe, expect, it } from "vitest";
import { KEYWORD_PLACEHOLDER, captionKeywordMismatch, dmCommentWord, captionMentionsKeyword, followKeywordForBrand, followKeywordInCaption, keywordCtaLine, quotedUpperWords, replaceKeywordInCaption } from "./dm-keyword-text";

describe("the DM keyword in a caption", () => {
  it("replaces the old keyword wherever it appears, whole-word and any case, always upper-cased", () => {
    const caption = 'Comment "hound" below and I\'ll DM you. Yes — HOUND. (Greyhound stays.)';
    expect(replaceKeywordInCaption(caption, "hound", "payout")).toBe('Comment "PAYOUT" below and I\'ll DM you. Yes — PAYOUT. (Greyhound stays.)');
    expect(captionMentionsKeyword(caption, "Hound")).toBe(true);
    expect(captionMentionsKeyword("nothing here", "hound")).toBe(false);
  });
  it("leaves the caption alone without a previous keyword, and builds the CTA line", () => {
    expect(replaceKeywordInCaption("hi", null, "payout")).toBe("hi");
    expect(replaceKeywordInCaption("hi HOUND", "hound", null)).toBe("hi HOUND");
    expect(keywordCtaLine("payout")).toBe('Comment "PAYOUT" and I\'ll DM you the link.');
  });
});

describe("the caption follows a keyword picked on the post page", () => {
  const pool = ["launchstack", "sidehustle", "launch", "firstsale"];
  it("swaps the post's previous keyword when the caption says it", () => {
    expect(followKeywordInCaption('Comment or DM me "LAUNCHSTACK" and I\'ll send it.', { prev: "launchstack", next: "firstsale", pool })).toBe(
      'Comment or DM me "FIRSTSALE" and I\'ll send it.',
    );
  });
  it("swaps another post's quoted keyword a copied caption brought along (no previous keyword on this post)", () => {
    const caption = "Ready to launch your app?\n\n👇 Comment or DM me “SIDEHUSTLE” and I'll send you the full episode.";
    expect(followKeywordInCaption(caption, { prev: null, next: "firstsale", pool })).toBe(
      "Ready to launch your app?\n\n👇 Comment or DM me “FIRSTSALE” and I'll send you the full episode.",
    );
  });
  it("fills the draft writer's \"KEYWORD\" placeholder (straight or curly quotes), even with another pool keyword nearby", () => {
    expect(KEYWORD_PLACEHOLDER).toBe("KEYWORD");
    expect(followKeywordInCaption('Comment "KEYWORD" and I\'ll DM you the playbook.', { prev: null, next: "firstsale", pool })).toBe(
      'Comment "FIRSTSALE" and I\'ll DM you the playbook.',
    );
    expect(followKeywordInCaption("Comment “KEYWORD” below. Like SIDEHUSTLE? “SIDEHUSTLE”", { prev: null, next: "firstsale", pool })).toBe(
      "Comment “FIRSTSALE” below. Like SIDEHUSTLE? “SIDEHUSTLE”",
    );
    // An unquoted word "keyword" in the copy is prose, not the placeholder.
    expect(followKeywordInCaption("Pick one keyword and own it.", { prev: null, next: "firstsale", pool })).toBe("Pick one keyword and own it.");
  });
  it("never rewrites an ordinary word that happens to be a pool keyword", () => {
    const caption = "How to launch in a week. Comment \"SIDEHUSTLE\" for the episode.";
    const out = followKeywordInCaption(caption, { prev: "launch", next: "firstsale", pool });
    // prev "launch" is in the caption as a word → that path is the existing whole-word swap
    expect(out).toContain("FIRSTSALE in a week");
    expect(followKeywordInCaption("How to launch in a week.", { prev: null, next: "firstsale", pool })).toBe("How to launch in a week.");
  });
  it("leaves the caption alone when two pool keywords are quoted, when the keyword is already there, or on detach", () => {
    const two = 'Comment "SIDEHUSTLE" or "LAUNCHSTACK"';
    expect(followKeywordInCaption(two, { prev: null, next: "firstsale", pool })).toBe(two);
    const already = 'Comment "FIRSTSALE"';
    expect(followKeywordInCaption(already, { prev: null, next: "firstsale", pool })).toBe(already);
    expect(followKeywordInCaption('Comment "SIDEHUSTLE"', { prev: "sidehustle", next: null, pool })).toBe('Comment "SIDEHUSTLE"');
  });
});

describe("the post page checks the caption against the post's keyword", () => {
  const pool = ["growthhack", "brainrot", "launch", "firstsale", "sidehustle"];
  it("flags a caption quoting another pool keyword, and the fix makes it say the attached one", () => {
    const caption = 'Comment "BRAINROT" and I\'ll DM you the playbook.';
    expect(captionKeywordMismatch(caption, { keyword: "growthhack", pool })).toEqual({ kind: "other", says: "BRAINROT" });
    const fixed = followKeywordInCaption(caption, { prev: null, next: "growthhack", pool });
    expect(fixed).toBe('Comment "GROWTHHACK" and I\'ll DM you the playbook.');
    expect(captionKeywordMismatch(fixed, { keyword: "growthhack", pool })).toBeNull();
  });
  it("flags the draft writer's placeholder, with or without a keyword attached", () => {
    const caption = "Comment “KEYWORD” below.";
    expect(captionKeywordMismatch(caption, { keyword: "firstsale", pool })).toEqual({ kind: "placeholder", says: KEYWORD_PLACEHOLDER });
    expect(captionKeywordMismatch(caption, { keyword: null, pool })).toEqual({ kind: "placeholder", says: KEYWORD_PLACEHOLDER });
  });
  it("stays quiet when the caption already says the keyword, says no pool keyword, or is ambiguous", () => {
    expect(captionKeywordMismatch('Comment "GROWTHHACK". Unlike "BRAINROT" posts…', { keyword: "growthhack", pool })).toBeNull();
    expect(captionKeywordMismatch("How to launch in a week.", { keyword: "growthhack", pool })).toBeNull();
    expect(captionKeywordMismatch('Comment "STARTERSTACK"', { keyword: "growthhack", pool })).toBeNull();
    expect(captionKeywordMismatch('"BRAINROT" or "SIDEHUSTLE"?', { keyword: "growthhack", pool })).toBeNull();
    expect(captionKeywordMismatch('Comment "BRAINROT"', { keyword: null, pool })).toBeNull();
  });
  it("finds the quoted upper-case words worth checking against the pool", () => {
    expect(quotedUpperWords('Comment "BRAINROT" — not "ok" — “AI” or “GROWTHHACK”', "growthhack")).toEqual(["BRAINROT"]);
    expect(quotedUpperWords("plain caption", null)).toEqual([]);
  });
});

describe("the caption follows a keyword on a Rebrandly brand (slugs are \"<short>-<word>\")", () => {
  // MFM/MATG keyword slugs carry the brand prefix ("mfm-ideasheet"), but
  // people comment the word ("IDEASHEET"). The caption used to get the slug.
  const pool = ["mfm-ideasheet", "mfm-ideavault", "mfm-p-1a2b3c4d"];
  it("fills the placeholder with the word people comment, not the slug", () => {
    const out = followKeywordForBrand('Comment "KEYWORD" and I\'ll DM you.', "my-first-million", { prev: null, next: "mfm-ideasheet", pool });
    expect(out).toEqual({ caption: 'Comment "IDEASHEET" and I\'ll DM you.', word: "IDEASHEET" });
  });
  it("swaps the previous keyword's word and another pool word the caption copied", () => {
    expect(followKeywordForBrand('DM me "IDEAVAULT" now', "my-first-million", { prev: "mfm-ideavault", next: "mfm-ideasheet", pool }).caption).toBe('DM me "IDEASHEET" now');
    expect(followKeywordForBrand('DM me "IDEAVAULT" now', "my-first-million", { prev: null, next: "mfm-ideasheet", pool }).caption).toBe('DM me "IDEASHEET" now');
  });
  it("accepts the word as well as the slug (the design editor passes words)", () => {
    expect(dmCommentWord("my-first-million", "ideasheet")).toBe("ideasheet");
    expect(dmCommentWord("my-first-million", "mfm-ideasheet")).toBe("ideasheet");
    expect(dmCommentWord("matg", "matg-p-1a2b3c4d")).toBeNull();
    expect(followKeywordForBrand('DM me "IDEAVAULT"', "my-first-million", { prev: "ideavault", next: "ideasheet" }).caption).toBe('DM me "IDEASHEET"');
  });
  it("never writes a per-post link into the caption, and leaves other brands' slugs as they are", () => {
    expect(followKeywordForBrand('Comment "KEYWORD"', "my-first-million", { prev: null, next: "mfm-p-1a2b3c4d", pool })).toEqual({ caption: 'Comment "KEYWORD"', word: null });
    expect(followKeywordForBrand('Comment "KEYWORD"', "starter-story", { prev: null, next: "traction", pool: [] })).toEqual({ caption: 'Comment "TRACTION"', word: "TRACTION" });
  });
});
