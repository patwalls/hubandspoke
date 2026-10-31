import { describe, it, expect } from "vitest";
import { draftPreview } from "./peek";
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
