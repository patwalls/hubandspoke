import { describe, expect, it } from "vitest";
import { inPublishOrder, publishRanks, type PublishedRow } from "./publish-order";

const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 18, m)).toISOString();
const family = (id: string, types: string[]): PublishedRow[] =>
  types.map((postType, i) => ({ family: id, postType, at: at(i * 4) }));

describe("publishRanks", () => {
  it("ranks each post type by where it usually falls in a post's run", () => {
    const ranks = publishRanks([
      ...family("a", ["x", "linkedin", "threads", "facebook_post", "tiktok"]),
      ...family("b", ["linkedin", "threads", "x", "facebook_post", "tiktok"]),
    ]);
    expect(ranks.get("tiktok")).toBe(1);
    expect(ranks.get("facebook_post")).toBe(0.75);
    expect(ranks.get("linkedin")).toBeLessThan(ranks.get("facebook_post")!);
  });

  it("reads time, not row order, and ignores lone publishes and one-off types", () => {
    const shuffled = family("a", ["linkedin", "tiktok"]).reverse();
    const ranks = publishRanks([
      ...shuffled,
      ...family("b", ["linkedin", "tiktok"]),
      ...family("c", ["youtube_community"]), // a post published alone says nothing about order
      ...family("d", ["threads", "linkedin"]), // threads seen in one family only
    ]);
    expect(ranks.get("tiktok")).toBe(1);
    expect(ranks.has("youtube_community")).toBe(false);
    expect(ranks.has("threads")).toBe(false);
  });
});

describe("inPublishOrder", () => {
  const rows = [{ id: "tt", postType: "tiktok" }, { id: "new", postType: "bluesky" }, { id: "li", postType: "linkedin" }];

  it("puts unranked types in the middle and keeps ties stable", () => {
    const ranks = new Map([["linkedin", 0.1], ["tiktok", 0.95]]);
    expect(inPublishOrder(rows, ranks).map((r) => r.id)).toEqual(["li", "new", "tt"]);
    expect(inPublishOrder(rows, new Map()).map((r) => r.id)).toEqual(["tt", "new", "li"]);
    expect(inPublishOrder(rows, null).map((r) => r.id)).toEqual(["tt", "new", "li"]);
  });
});
