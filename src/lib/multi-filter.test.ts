import { describe, it, expect } from "vitest";
import { parseChannelFilter, serializeChannelFilter } from "./multi-filter";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("parseChannelFilter", () => {
  it("treats all / empty as no filter", () => {
    expect(parseChannelFilter("all")).toBeNull();
    expect(parseChannelFilter("")).toBeNull();
    expect(parseChannelFilter(null)).toBeNull();
  });

  it("parses account|postType pairs, including no-post-type channels", () => {
    expect(parseChannelFilter(`${A}|instagram_reel,${B}|`)).toEqual([
      { accountId: A, postType: "instagram_reel" },
      { accountId: B, postType: null },
    ]);
  });

  it("drops malformed account ids and duplicates", () => {
    expect(parseChannelFilter(`nope|x,${A}|x,${A}|x`)).toEqual([
      { accountId: A, postType: "x" },
    ]);
    expect(parseChannelFilter("'; drop table|x")).toBeNull();
  });
});

describe("serializeChannelFilter", () => {
  const all = [`${A}|x`, `${B}|`];

  it("collapses empty and full selections to all", () => {
    expect(serializeChannelFilter([], all)).toBe("all");
    expect(serializeChannelFilter([`${B}|`, `${A}|x`], all)).toBe("all");
  });

  it("joins a partial selection", () => {
    expect(serializeChannelFilter([`${A}|x`], all)).toBe(`${A}|x`);
  });
});
