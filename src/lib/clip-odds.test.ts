import { describe, expect, it } from "vitest";
import {
  compareIdeasByOdds,
  oddsWhy,
  computeFormatOdds,
  oddsKey,
  oddsPromptBlock,
  type FormatOdds,
  type PublishedRow,
} from "./clip-odds";

const NOW = new Date("2026-11-07T12:00:00Z");
const d = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** Ten ordinary posts a day-ish apart on `platform`, each `views`. */
function usualPosts(brand: string, platform: string, views: number, from = 200, to = 1): PublishedRow[] {
  const out: PublishedRow[] = [];
  for (let a = from; a >= to; a -= 5) out.push({ brand, format: "Pillar", platform, views, publishedDate: d(a) });
  return out;
}

describe("computeFormatOdds", () => {
  it("counts a format's recent clips that beat the account's usual on their platform", () => {
    const rows: PublishedRow[] = [
      ...usualPosts("matg", "Instagram Reel", 1000),
      ...usualPosts("matg", "X", 100),
      // Reels clips: 2 of 6 beat the 1000 usual.
      ...[1500, 2000, 400, 500, 600, 700].map((views, i) => ({ brand: "matg", format: "Podcast Clip With Hook", platform: "Instagram Reel", views, publishedDate: d(10 + i * 7) })),
      // X clips: 5 of 6 beat the 100 usual — far fewer views, far better odds.
      ...[300, 200, 150, 120, 110, 50].map((views, i) => ({ brand: "matg", format: "X Quotables", platform: "X", views, publishedDate: d(10 + i * 7) })),
    ];
    const odds = computeFormatOdds(rows, NOW);
    const reel = odds.get(oddsKey("matg", "Podcast Clip With Hook"))!;
    const x = odds.get(oddsKey("matg", "X Quotables"))!;
    expect([reel.beat, reel.clips, reel.platform]).toEqual([2, 6, "Instagram Reel"]);
    expect([x.beat, x.clips, x.platform]).toEqual([5, 6, "X"]);
    expect(x.typicalViews).toBe(135);
    // "Usual" is the account's posts on that platform; the clips themselves count too.
    expect(reel.usualViews).toBe(1000);
  });

  it("judges each clip against the usual at the time it went out", () => {
    // The account's usual jumped from 100 to 10,000 four months ago. Clips of
    // 1,000 views before the jump beat it; the same 1,000 after does not.
    const rows: PublishedRow[] = [
      ...usualPosts("ss", "X", 100, 400, 121),
      ...usualPosts("ss", "X", 10_000, 120, 1),
      ...[150, 160, 170].map((a) => ({ brand: "ss", format: "Q", platform: "X", views: 1000, publishedDate: d(a) })),
      ...[20, 25, 30].map((a) => ({ brand: "ss", format: "Q", platform: "X", views: 1000, publishedDate: d(a) })),
    ];
    const q = computeFormatOdds(rows, NOW).get(oddsKey("ss", "Q"))!;
    expect([q.beat, q.clips]).toEqual([3, 6]);
  });

  it("has no record for a format with fewer than 5 scorable clips, or only stale ones", () => {
    const rows: PublishedRow[] = [
      ...usualPosts("ss", "X", 100, 600, 1),
      ...[1, 2, 3, 4].map((i) => ({ brand: "ss", format: "New", platform: "X", views: 500, publishedDate: d(i * 10) })),
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ brand: "ss", format: "Old", platform: "X", views: 500, publishedDate: d(400 + i * 10) })),
    ];
    const odds = computeFormatOdds(rows, NOW);
    expect(odds.has(oddsKey("ss", "New"))).toBe(false);
    expect(odds.has(oddsKey("ss", "Old"))).toBe(false);
  });

  it("keeps brands apart even when they share a format name", () => {
    const rows: PublishedRow[] = [
      ...usualPosts("a", "X", 100),
      ...usualPosts("b", "X", 100),
      ...[1, 2, 3, 4, 5].map((i) => ({ brand: "a", format: "X Quotables", platform: "X", views: 1000, publishedDate: d(i * 7) })),
      ...[1, 2, 3, 4, 5].map((i) => ({ brand: "b", format: "X Quotables", platform: "X", views: 10, publishedDate: d(i * 7) })),
    ];
    const odds = computeFormatOdds(rows, NOW);
    expect(odds.get(oddsKey("a", "X Quotables"))!.beat).toBe(5);
    expect(odds.get(oddsKey("b", "X Quotables"))!.beat).toBe(0);
  });
});

describe("compareIdeasByOdds", () => {
  const rec = (beat: number, clips = 10) => ({ beat, clips }) as FormatOdds;
  it("puts the format that beats the usual most often first, then video order — never the writer's guess", () => {
    const ideas = [
      { id: "reel-late", odds: rec(3), startSec: 900, estimatedViews: 900_000 },
      { id: "x-late", odds: rec(8), startSec: 600, estimatedViews: 1_000 },
      { id: "new-format", odds: null, startSec: 10, estimatedViews: 5_000 },
      { id: "x-early", odds: rec(8), startSec: 30, estimatedViews: 2_000 },
    ];
    expect([...ideas].sort(compareIdeasByOdds).map((i) => i.id)).toEqual(["x-early", "x-late", "new-format", "reel-late"]);
  });
});

describe("oddsPromptBlock", () => {
  it("gives the writer the format's real median and range, and none without a record", () => {
    const block = oddsPromptBlock({ brand: "ss", format: "X Quotables", platform: "X", clips: 20, beat: 11, typicalViews: 2100, p25: 1200, p75: 4000, usualViews: 1800 })!;
    expect(block).toContain("median 2,100 views, middle half 1,200–4,000");
    expect(block).toContain("11 of 20 beat");
    expect(block).toContain("best hits, not what a typical clip gets");
    expect(oddsPromptBlock(null)).toBeNull();
  });
});

describe("oddsWhy", () => {
  const base = { brand: "ss", format: "X Quotables", platform: "X", clips: 20, beat: 11, usualViews: 1800 };
  it("says how many beat the usual, the usual, and the typical clip with its range", () => {
    expect(oddsWhy({ ...base, typicalViews: 2100, p25: 1200, p75: 4000 })).toBe(
      "11 of the last 20 X Quotables clips beat this account's usual X post (about 1.8K views now). Typical clip: 2.1K views (1.2K–4K).",
    );
  });
  it("drops a range that collapses to one number", () => {
    expect(oddsWhy({ ...base, typicalViews: 1000, p25: 1000, p75: 1000 })).toMatch(/Typical clip: 1K views\.$/);
  });
});
