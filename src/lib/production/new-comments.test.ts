import { describe, it, expect } from "vitest";
import { newCommentsFor, RECENT_COMMENT_HOURS } from "./new-comments";

const NOW = new Date("2026-11-02T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ME = "user-me";

describe("newCommentsFor", () => {
  it("is null with no comments", () => {
    expect(newCommentsFor(undefined, ME, NOW)).toBeNull();
    expect(newCommentsFor([], ME, NOW)).toBeNull();
  });

  it("never counts the viewer's own comments", () => {
    expect(newCommentsFor([{ at: hoursAgo(1), byUserId: ME, by: "Pat" }], ME, NOW)).toBeNull();
  });

  it("counts others' comments inside the window and names the latest", () => {
    const out = newCommentsFor(
      [
        { at: hoursAgo(30), byUserId: "u2", by: "Sam" },
        { at: hoursAgo(3), byUserId: "u1", by: "Kate" },
        { at: hoursAgo(2), byUserId: ME, by: "Pat" },
      ],
      ME,
      NOW,
    );
    expect(out).toEqual({
      count: 2,
      title: "2 new comments in the last 2 days · latest from Kate, 3h ago",
    });
  });

  it("drops comments older than the window even if the cached report still has them", () => {
    const old = { at: hoursAgo(RECENT_COMMENT_HOURS + 1), byUserId: "u1", by: "Kate" };
    expect(newCommentsFor([old], ME, NOW)).toBeNull();
  });

  it("counts an authorless (Notion-synced) comment, without a name", () => {
    expect(newCommentsFor([{ at: hoursAgo(0.5), byUserId: null, by: null }], ME, NOW)).toEqual({
      count: 1,
      title: "1 new comment in the last 2 days · latest 30m ago",
    });
  });

  it("ignores an unparseable time", () => {
    expect(newCommentsFor([{ at: "nope", byUserId: "u1", by: "Kate" }], ME, NOW)).toBeNull();
  });
});
