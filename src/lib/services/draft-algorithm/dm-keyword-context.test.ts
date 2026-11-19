import { describe, expect, it } from "vitest";
import { dmKeywordContext } from "./dm-keyword-context";
import { renderDmKeywordBlock } from "@/lib/draft-agent";

describe("the draft writer's DM keyword context", () => {
  it("gives Starter Story Instagram posts their attached keyword, or null when none is attached", () => {
    expect(dmKeywordContext({ brand: "starter-story", postType: "instagram_reel", shortLinkSlug: "launchstack" })).toEqual({ word: "launchstack" });
    expect(dmKeywordContext({ brand: "starter-story", postType: "instagram_post", shortLinkSlug: null })).toEqual({ word: null });
  });
  it("uses the comment word for Rebrandly brands, and treats a leftover Starter Story slug as no keyword", () => {
    expect(dmKeywordContext({ brand: "my-first-million", postType: "instagram_reel", shortLinkSlug: "mfm-ideavault" })).toEqual({ word: "ideavault" });
    expect(dmKeywordContext({ brand: "matg", postType: "instagram_reel", shortLinkSlug: "launchstack" })).toEqual({ word: null });
  });
  it("is absent for non-Instagram posts, stories, and brands without DM keywords", () => {
    expect(dmKeywordContext({ brand: "starter-story", postType: "tiktok", shortLinkSlug: "launchstack" })).toBeUndefined();
    expect(dmKeywordContext({ brand: "starter-story", postType: "instagram_story", shortLinkSlug: null })).toBeUndefined();
    expect(dmKeywordContext({ brand: "futurepedia", postType: "instagram_reel", shortLinkSlug: null })).toBeUndefined();
  });
});

describe("the DM KEYWORD prompt block", () => {
  it("names the post's own keyword, upper-cased, and forbids the ones in past captions", () => {
    const block = renderDmKeywordBlock({ word: "launchstack" })!;
    expect(block).toContain('"LAUNCHSTACK"');
    expect(block).toContain("Never use any other keyword");
    expect(block).not.toContain('"KEYWORD"');
  });
  it("without a keyword, tells the writer to use the KEYWORD placeholder instead of copying or inventing one", () => {
    const block = renderDmKeywordBlock({ word: null })!;
    expect(block).toContain('"KEYWORD"');
    expect(block).toMatch(/never copy one and never make one up/);
  });
  it("renders nothing when the post can't carry a keyword", () => {
    expect(renderDmKeywordBlock(undefined)).toBeNull();
  });
});
