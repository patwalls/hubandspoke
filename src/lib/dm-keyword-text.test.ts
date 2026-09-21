import { describe, expect, it } from "vitest";
import { captionMentionsKeyword, keywordCtaLine, replaceKeywordInCaption } from "./dm-keyword-text";

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
