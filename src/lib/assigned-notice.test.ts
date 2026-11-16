import { describe, expect, it } from "vitest";
import { assignedNoticeText } from "./assigned-notice";

describe("assignedNoticeText", () => {
  it("says the editor was emailed, by first name", () => {
    expect(assignedNoticeText({ name: "Rita Reviewer", delivery: "email" })).toBe(
      "Rita was notified by email and in their bell",
    );
  });

  it("warns when no email could go out (no login yet)", () => {
    expect(assignedNoticeText({ name: "Rita", delivery: "bell" })).toBe(
      "Rita has no login yet, so they weren't emailed — let them know another way",
    );
  });

  it("stays quiet when nobody was told (self-assign, unassign, deactivated)", () => {
    expect(assignedNoticeText({ name: "Rita", delivery: "none" })).toBeNull();
    expect(assignedNoticeText(null)).toBeNull();
    expect(assignedNoticeText(undefined)).toBeNull();
  });

  it("falls back when the name is missing", () => {
    expect(assignedNoticeText({ name: null, delivery: "email" })).toBe(
      "The editor was notified by email and in their bell",
    );
  });
});
