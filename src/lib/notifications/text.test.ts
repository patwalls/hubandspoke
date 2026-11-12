import { describe, it, expect } from "vitest";
import { notificationText } from "./text";

describe("notificationText", () => {
  it("names who did it for collaboration events", () => {
    expect(notificationText({ kind: "assigned", title: "T" }, "Sam")).toEqual({
      headline: "Sam assigned this to you",
      excerpt: null,
    });
    expect(
      notificationText({ kind: "mention", title: "T", excerpt: "look", authorName: "Sam" }, "Sam"),
    ).toEqual({ headline: "Sam mentioned you", excerpt: "look" });
  });

  // A win has no actor (the cron writes it) — the headline must not fall back
  // to "A teammate …", and the why-it-won note is the line under the title.
  it("tells the editor their post won, with the lift and the why", () => {
    const t = notificationText(
      { kind: "win", title: "T", lift: 4.24, note: "The hook names the dollar figure first." },
      "A teammate",
    );
    expect(t.headline).toBe("A post you edited beat its usual · 4.2×");
    expect(t.headline).not.toContain("teammate");
    expect(t.excerpt).toBe("The hook names the dollar figure first.");
  });

  it("shows an unknown kind as a plain update instead of crashing the bell", () => {
    const t = notificationText({ kind: "later-kind" } as never, "Sam");
    expect(t).toEqual({ headline: "Update", excerpt: null });
  });
});
