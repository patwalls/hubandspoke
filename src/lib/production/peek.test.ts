import { describe, it, expect } from "vitest";
import { draftPreview, nextAfter, peekCanPublish } from "./peek";
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
