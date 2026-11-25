import { describe, expect, it } from "vitest";
import { BADGE_WINDOW_DAYS, badgeWindowStart, parseMarkReadBody } from "./unread";

describe("parseMarkReadBody", () => {
  it("accepts all / ids as before", () => {
    expect(parseMarkReadBody({ all: true })).toEqual({ kind: "all" });
    expect(parseMarkReadBody({ ids: ["a", 3, "b"] })).toEqual({ kind: "ids", ids: ["a", "b"] });
  });

  it("accepts a post id so opening a post clears its notifications", () => {
    const id = "5b1f7a52-6a3e-4c1e-9b0a-2f6f3d1c9e11";
    expect(parseMarkReadBody({ contentItemId: id })).toEqual({ kind: "item", contentItemId: id });
  });

  it("rejects a contentItemId that is not a uuid (it goes into a uuid column)", () => {
    expect(parseMarkReadBody({ contentItemId: "not-a-uuid" })).toBeNull();
  });

  it("rejects empty or unknown bodies", () => {
    expect(parseMarkReadBody(null)).toBeNull();
    expect(parseMarkReadBody({})).toBeNull();
    expect(parseMarkReadBody({ ids: [] })).toBeNull();
    expect(parseMarkReadBody({ all: "yes" })).toBeNull();
  });
});

describe("badgeWindowStart", () => {
  it("is BADGE_WINDOW_DAYS before now", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    expect(BADGE_WINDOW_DAYS).toBe(14);
    expect(badgeWindowStart(now).toISOString()).toBe("2026-11-11T12:00:00.000Z");
  });
});
