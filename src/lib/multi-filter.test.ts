import { describe, it, expect } from "vitest";
import {
  multiFilterAllows,
  parseAccountFilter,
  parseChannelFilter,
  parseMultiFilter,
  serializeMultiFilter,
} from "./multi-filter";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseMultiFilter", () => {
  it("treats all / empty as no filter", () => {
    expect(parseMultiFilter("all")).toBeNull();
    expect(parseMultiFilter("")).toBeNull();
    expect(parseMultiFilter(null)).toBeNull();
    expect(parseMultiFilter(" , ")).toBeNull();
    expect(parseMultiFilter("!")).toBeNull();
  });

  it("keeps legacy single values working", () => {
    expect(parseMultiFilter("youtube_long")).toEqual({ mode: "include", items: ["youtube_long"] });
    expect(parseMultiFilter("100% Real")).toEqual({ mode: "include", items: ["100% Real"] });
  });

  it("reads a leading ! as exclude mode", () => {
    expect(parseMultiFilter("!youtube_long")).toEqual({ mode: "exclude", items: ["youtube_long"] });
  });
});

describe("serializeMultiFilter", () => {
  const all = ["a", "b", "c", "d"];

  it("collapses empty and full selections to all", () => {
    expect(serializeMultiFilter([], all)).toBe("all");
    expect(serializeMultiFilter(["d", "c", "b", "a"], all)).toBe("all");
  });

  it("writes whichever list is shorter", () => {
    expect(serializeMultiFilter(["a"], all)).toBe("a");
    expect(serializeMultiFilter(["a", "b", "c"], all)).toBe("!d");
  });

  it("round-trips values with commas, percents and a leading !", () => {
    const opts = ["Tips, tricks", "100%", "!bang", "x", "y"];
    for (const picked of [["Tips, tricks", "100%"], ["!bang", "x", "y", "100%"]]) {
      const f = parseMultiFilter(serializeMultiFilter(picked, opts));
      expect(opts.filter((o) => multiFilterAllows(f, o)).sort()).toEqual([...picked].sort());
    }
  });
});

describe("parseAccountFilter", () => {
  it("drops non-UUID ids", () => {
    expect(parseAccountFilter(`${A},nope`)).toEqual({ mode: "include", items: [A] });
    expect(parseAccountFilter("nope")).toBeNull();
  });
});

describe("parseChannelFilter", () => {
  it("parses account|postType pairs in either mode", () => {
    expect(parseChannelFilter(`${A}|instagram_reel,${B}|`)).toEqual({
      mode: "include",
      channels: [
        { accountId: A, postType: "instagram_reel" },
        { accountId: B, postType: null },
      ],
    });
    expect(parseChannelFilter(`!${A}|youtube_long`)).toEqual({
      mode: "exclude",
      channels: [{ accountId: A, postType: "youtube_long" }],
    });
  });

  it("drops malformed account ids", () => {
    expect(parseChannelFilter(`nope|x,${A}|x`)?.channels).toEqual([{ accountId: A, postType: "x" }]);
    expect(parseChannelFilter("'; drop table|x")).toBeNull();
  });
});
