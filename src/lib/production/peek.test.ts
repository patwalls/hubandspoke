import { describe, it, expect } from "vitest";
import { draftPreview, nextAfter, peekCanApprove, peekCanPublish, peekStaleReview } from "./peek";
import type { FormatFieldSchema } from "@/lib/db/schema";

const schema: FormatFieldSchema = {
  version: 1,
  fields: [
    { key: "hook", label: "Hook", type: "text", prompt: "" },
    { key: "caption", label: "Caption", type: "longtext", prompt: "" },
    { key: "tags", label: "Hashtags", type: "tags", prompt: "" },
    { key: "slides", label: "Slides", type: "slides", prompt: "" },
  ],
};

describe("the row peek's draft preview", () => {
  it("shows written fields in the format's order, skipping empty ones", () => {
    const out = draftPreview({ caption: "The caption", hook: "  ", tags: ["a", "b"], slides: null }, schema);
    expect(out).toEqual([
      { label: "Caption", text: "The caption" },
      { label: "Hashtags", text: "a, b" },
    ]);
  });

  it("reads slides as paragraphs", () => {
    const out = draftPreview(
      { slides: [{ id: "1", order: 0, text: "One" }, { id: "2", order: 1, text: "Two" }] },
      schema,
    );
    expect(out).toEqual([{ label: "Slides", text: "One\n\nTwo" }]);
  });

  it("still shows fields the snapshot doesn't name, after the named ones", () => {
    const out = draftPreview({ tweet_text: "Hello", caption: "C" }, schema);
    expect(out.map((f) => f.label)).toEqual(["Caption", "Tweet text"]);
  });

  it("cuts long text and caps how many fields show", () => {
    const out = draftPreview(
      { hook: "h", caption: "x".repeat(50), tags: ["t"], slides: [{ id: "1", order: 0, text: "s" }] },
      schema,
      { maxFields: 2, maxChars: 10 },
    );
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe("xxxxxxxxx…");
  });

  it("is empty with no draft", () => {
    expect(draftPreview(null, schema)).toEqual([]);
  });
});

describe("peekCanPublish", () => {
  it("offers the link box on posts about to go live, to people who can edit", () => {
    expect(peekCanPublish("Review", true)).toBe(true);
    expect(peekCanPublish("Ready To Publish", true)).toBe(true);
  });
  it("never on posts still being made, already dated, or live — or read-only viewers", () => {
    for (const s of ["Assigned", "Idea", "Scheduled", "Published", null, undefined]) {
      expect(peekCanPublish(s, true)).toBe(false);
    }
    expect(peekCanPublish("Review", false)).toBe(false);
  });
});

describe("nextAfter", () => {
  it("steps to the next row, or back one at the end, or nowhere", () => {
    expect(nextAfter(["a", "b", "c"], "b")).toBe("c");
    expect(nextAfter(["a", "b", "c"], "c")).toBe("b");
    expect(nextAfter(["a"], "a")).toBeNull();
    expect(nextAfter(["a", "b"], "z")).toBeNull();
  });
});

describe("peekCanApprove", () => {
  it("only on a Review post, only for someone who can edit the brand", () => {
    expect(peekCanApprove("Review", true)).toBe(true);
    expect(peekCanApprove("Review", false)).toBe(false);
    // Already approved / still being edited / live: nothing to approve.
    for (const s of ["Ready To Publish", "Assigned", "Published", "On Hold", null]) {
      expect(peekCanApprove(s, true)).toBe(false);
    }
  });
});

describe("peekStaleReview", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const daysAgo = (d: number) => new Date(now - d * 24 * 3600 * 1000).toISOString();

  // The shapes of every post sitting in Review on prod, 2026-11-21.
  it("abandoned: in Review 62 d, last comment 17 d ago", () => {
    expect(peekStaleReview("Review", daysAgo(62), daysAgo(17), now)).toBe(true);
  });
  it("not abandoned: in Review 11 d but commented 4 d ago", () => {
    expect(peekStaleReview("Review", daysAgo(11), daysAgo(4), now)).toBe(false);
  });
  it("not abandoned: in Review 20 d but someone commented this week", () => {
    expect(peekStaleReview("Review", daysAgo(20), daysAgo(3), now)).toBe(false);
  });
  it("in Review 14 d+ with no comments at all is stale", () => {
    expect(peekStaleReview("Review", daysAgo(15), null, now)).toBe(true);
  });
  it("a fresh Review post with no comments is not", () => {
    expect(peekStaleReview("Review", daysAgo(1), null, now)).toBe(false);
  });
  it("never without a known move date, never outside Review", () => {
    expect(peekStaleReview("Review", null, null, now)).toBe(false);
    expect(peekStaleReview("Ready To Publish", daysAgo(60), null, now)).toBe(false);
    expect(peekStaleReview("On Hold", daysAgo(60), null, now)).toBe(false);
  });
});
