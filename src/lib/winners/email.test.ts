import { describe, it, expect } from "vitest";
import { buildWinnersEmail, type EmailWinner, type WinnersEmailBrand } from "./email";

const w = (id: string, lift: number, extra: Partial<EmailWinner> = {}) => ({
  lift,
  item: {
    id,
    title: id,
    views: lift * 1_000,
    baselineMedian: 1_000,
    baselinePosts: 10,
    accountHandle: "starterstory",
    platform: "youtube",
    postType: "youtube_shorts",
    format: "Clip",
    winNote: null,
    ...extra,
  },
});
const brand = (slug: string, winners: ReturnType<typeof w>[], formats: WinnersEmailBrand["formats"] = []) => ({
  slug,
  label: slug.toUpperCase(),
  winners,
  formats,
});
const base = { firstName: "Pat", baseUrl: "https://app.test" };

describe("buildWinnersEmail", () => {
  it("sends nothing when no brand had a winner", () => {
    expect(buildWinnersEmail({ ...base, brands: [brand("a", []), brand("b", [])] })).toBeNull();
  });

  it("names the count and the biggest lift in the subject, and drops brands with no winners", () => {
    const e = buildWinnersEmail({
      ...base,
      brands: [brand("quiet", []), brand("a", [w("Small hit", 2)]), brand("b", [w("Huge hit", 12), w("Ok", 1.6)])],
    })!;
    expect(e.subject).toBe('3 posts beat their usual last week — top: 12× "Huge hit"');
    expect(e.text).not.toContain("QUIET");
    // Most winners first.
    expect(e.text.indexOf("== B ==")).toBeLessThan(e.text.indexOf("== A =="));
    expect(e.text).toContain("https://app.test/b/content/Huge hit");
    expect(e.text).toContain("(@starterstory · YouTube Short · Clip)");
  });

  it("shows why it won, likes for likes-judged posts, and the top formats", () => {
    const e = buildWinnersEmail({
      ...base,
      brands: [
        brand(
          "a",
          [w("Thread", 4, { metric: "likes", likes: 200, baselineLikesMedian: 50, winNote: { note: "Named a <price>." } })],
          [
            { format: "One", posts: 4, wins: 3, hitRate: 0.75, bestLift: 4 },
            { format: "Two", posts: 5, wins: 2, hitRate: 0.4, bestLift: 2 },
            { format: "Three", posts: 5, wins: 1, hitRate: 0.2, bestLift: 1.5 },
            { format: "Four", posts: 9, wins: 1, hitRate: 0.1, bestLift: 1.5 },
          ],
        ),
      ],
    })!;
    expect(e.text).toContain("200 likes vs usual 50");
    expect(e.text).toContain("Why: Named a <price>.");
    expect(e.html).toContain("Why: Named a &lt;price&gt;.");
    expect(e.text).toContain("One: 3 of 4 posts (best 4.0×)");
    expect(e.text).not.toContain("Four:");
  });
});
