import { describe, it, expect } from "vitest";
import { channelReachLabel, compactViews, quietChannels } from "./channel-reach";

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
