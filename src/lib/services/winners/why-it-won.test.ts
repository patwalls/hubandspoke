import { describe, it, expect } from "vitest";
import { buildWhyPrompt, parseWhyNote } from "./why-it-won";

const post = (over: Partial<Parameters<typeof buildWhyPrompt>[1][number]> = {}) => ({
  title: null,
  hook: null,
  overlay: null,
  caption: null,
  format: null,
  ...over,
});
const winner = (over = {}) => ({
  ...post({ hook: "He made $40k/mo from a spreadsheet", format: "Repackage Section w/ Hook" }),
  platform: "tiktok",
  postType: "tiktok",
  lift: 8.4,
  metric: "views" as const,
  ...over,
});

describe("buildWhyPrompt", () => {
  it("puts the winner first, then each usual post, with only the fields that exist", () => {
    const p = buildWhyPrompt(winner(), [post({ hook: "Meet the founder of X" }), post({ caption: "A day in the life" })])!;
    expect(p).toContain("8.4× this account's usual views");
    expect(p.indexOf("<winner>")).toBeLessThan(p.indexOf('<usual_post n="1">'));
    expect(p).toContain("Hook: He made $40k/mo from a spreadsheet");
    expect(p).toContain("Format: Repackage Section w/ Hook");
    expect(p).toContain('<usual_post n="2">\nCaption: A day in the life');
    expect(p).not.toContain("On-screen text:");
  });

  it("says likes when the post was judged on likes", () => {
    expect(buildWhyPrompt(winner({ metric: "likes" }), [post({ hook: "x" })])).toContain("usual likes");
  });

  it("has nothing to compare without usual posts or without any text on the winner", () => {
    expect(buildWhyPrompt(winner(), [])).toBeNull();
    expect(buildWhyPrompt(winner({ hook: null, format: "Tech Stack" }), [post({ hook: "x" })])).toBeNull();
  });

  it("trims long captions so one post can't crowd out the rest", () => {
    const p = buildWhyPrompt(winner(), [post({ caption: "word ".repeat(500) })])!;
    expect(p.length).toBeLessThan(1200);
    expect(p).toContain("…");
  });
});

describe("parseWhyNote", () => {
  it("keeps one clean line and drops wrapping quotes", () => {
    expect(parseWhyNote('  "Opens on a dollar figure;\n the usual posts open on a name."  ')).toBe(
      "Opens on a dollar figure; the usual posts open on a name.",
    );
  });

  it("rejects empties, non-strings and essays", () => {
    expect(parseWhyNote("")).toBeNull();
    expect(parseWhyNote(null)).toBeNull();
    expect(parseWhyNote({ note: "x" })).toBeNull();
    expect(parseWhyNote("x".repeat(181))).toBeNull();
  });
});
