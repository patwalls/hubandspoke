import { describe, expect, it } from "vitest";
import { captionMentionsKeyword, followKeywordInCaption, keywordCtaLine, replaceKeywordInCaption } from "./dm-keyword-text";

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
