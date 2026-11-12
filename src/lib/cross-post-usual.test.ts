import { describe, expect, it } from "vitest";
import { usualTargetKeys, type TargetCommonalityRow } from "./cross-post-usual";

const row = (accountId: string, postType: string, recentSources: number, recentTotal: number, count = recentSources): TargetCommonalityRow => ({
  accountId,
  postType,
  count,
  recentSources,
  recentTotal,
});

describe("usualTargetKeys", () => {
  it("picks the pairs at least half of the format's recent sources went to", () => {
    // 28 sources: TikTok + Shorts nearly always, X on 13 of them (not a habit).
    const ranking = [row("tt", "tiktok", 26, 28), row("yt", "youtube_shorts", 26, 28), row("x", "x", 13, 28)];
    expect(usualTargetKeys(ranking, ["tt:tiktok", "yt:youtube_shorts", "x:x"])).toEqual([
      "tt:tiktok",
      "yt:youtube_shorts",
    ]);
  });

  it("counts exactly half as usual", () => {
    expect(usualTargetKeys([row("a", "x", 2, 4)], ["a:x"])).toEqual(["a:x"]);
  });

  it("has no usual until the format has 3 recent sources", () => {
    expect(usualTargetKeys([row("a", "x", 2, 2)], ["a:x"])).toEqual([]);
  });

  it("skips targets already cross-posted or no longer on the brand", () => {
    const ranking = [row("a", "x", 5, 5), row("b", "threads", 5, 5), row("gone", "linkedin", 5, 5)];
    expect(usualTargetKeys(ranking, ["b:threads"])).toEqual(["b:threads"]);
  });

  it("ignores rows without recent counts (old payloads, all-time-only history)", () => {
    expect(usualTargetKeys([{ accountId: "a", postType: "x", count: 40 }], ["a:x"])).toEqual([]);
    expect(usualTargetKeys(undefined, ["a:x"])).toEqual([]);
  });
});
