import { describe, it, expect } from "vitest";
import { leavePublishedConfirm } from "./leave-published";

describe("leavePublishedConfirm", () => {
  it("asks before a Published post moves back, naming its platform", () => {
    expect(leavePublishedConfirm("Published", "Review", "youtube_long")).toBe(
      "This YouTube post is already Published. Move it back to Review?",
    );
  });

  it("asks without a platform when the post type is unknown", () => {
    expect(leavePublishedConfirm("Published", "Assigned", null)).toBe(
      "This post is already Published. Move it back to Assigned?",
    );
  });

  it("stays one click for every move that doesn't start at Published", () => {
    expect(leavePublishedConfirm("Review", "Assigned", "youtube_long")).toBeNull();
    expect(leavePublishedConfirm("Ready To Publish", "Review", null)).toBeNull();
    expect(leavePublishedConfirm(null, "Idea", null)).toBeNull();
  });

  it("leaves Kill to its own dialog and ignores no-op or cleared values", () => {
    expect(leavePublishedConfirm("Published", "Killed", null)).toBeNull();
    expect(leavePublishedConfirm("Published", "Published", null)).toBeNull();
    expect(leavePublishedConfirm("Published", "", null)).toBeNull();
  });
});
