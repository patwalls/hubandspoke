import { describe, it, expect } from "vitest";
import { accountReachLines, channelReachLabel, compactViews, quietChannels } from "./channel-reach";

describe("compactViews", () => {
  it("keeps small numbers whole and shortens big ones", () => {
    expect(compactViews(256.5)).toBe("257");
    expect(compactViews(1650)).toBe("1.7K");
    expect(compactViews(14216.5)).toBe("14K");
    expect(compactViews(999_600)).toBe("1M");
    expect(compactViews(2_100_000)).toBe("2.1M");
  });
});

describe("channelReachLabel", () => {
  it("shows nothing without enough history", () => {
    expect(channelReachLabel(undefined)).toBeNull();
    expect(channelReachLabel({ posts: 4, medianViews: 900, zeroLikes: 0 })).toBeNull();
    expect(channelReachLabel({ posts: 9, medianViews: null, zeroLikes: 0 })).toBeNull();
  });

  it("gives a typical-views line with the numbers in the tooltip", () => {
    const l = channelReachLabel({ posts: 90, medianViews: 1650, zeroLikes: 0 });
    expect(l).toEqual({
      text: "~1.7K views",
      title: "Last 30 days: 90 posts here, typical post 1,650 views.",
      quiet: false,
    });
  });

  it("flags a channel where most posts got no likes", () => {
    const l = channelReachLabel({ posts: 32, medianViews: 256.5, zeroLikes: 20 });
    expect(l?.quiet).toBe(true);
    expect(l?.text).toBe("~257 views · mostly no likes");
    expect(l?.title).toContain("20 of 32 got no likes");
  });

  it("a minority of zero-like posts is not quiet", () => {
    expect(channelReachLabel({ posts: 30, medianViews: 320, zeroLikes: 9 })?.quiet).toBe(false);
    // exactly half is
    expect(channelReachLabel({ posts: 10, medianViews: 77, zeroLikes: 5 })?.quiet).toBe(true);
  });
});

describe("quietChannels", () => {
  const row = (handle: string, posts: number, zeroLikes: number) => ({
    handle,
    postType: "facebook_post",
    posts,
    zeroLikes,
    medianViews: 10,
  });

  it("keeps channels with 10+ posts where at least half got no likes, most no-like posts first", () => {
    const out = quietChannels([
      row("half", 10, 5),
      row("loud", 40, 19),
      row("few", 9, 9),
      row("worst", 32, 20),
    ]);
    expect(out.map((r) => r.handle)).toEqual(["worst", "half"]);
  });
});

describe("accountReachLines", () => {
  const reach = {
    "acc-1:instagram_post": { posts: 8, medianViews: 63, zeroLikes: 6 },
    "acc-1:instagram_reel": { posts: 20, medianViews: 1500, zeroLikes: 0 },
    "acc-1:instagram_story": { posts: 3, medianViews: 900, zeroLikes: 0 },
    "acc-10:x": { posts: 40, medianViews: 70, zeroLikes: 30 },
  };

  it("lists only this account's types with enough history, busiest first", () => {
    const lines = accountReachLines(reach, "acc-1");
    expect(lines.map((l) => l.postType)).toEqual(["instagram_reel", "instagram_post"]);
    expect(lines[0]).toMatchObject({ text: "~1.5K views", quiet: false });
    expect(lines[1]).toMatchObject({ text: "~63 views · mostly no likes", quiet: true });
  });

  it("does not match an account whose id merely starts with this one", () => {
    expect(accountReachLines(reach, "acc-1").some((l) => l.postType === "x")).toBe(false);
    expect(accountReachLines(reach, "acc-10").map((l) => l.postType)).toEqual(["x"]);
  });

  it("is empty for an account with no recent posts", () => {
    expect(accountReachLines(reach, "acc-2")).toEqual([]);
  });
});
