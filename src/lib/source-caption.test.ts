import { describe, expect, it } from "vitest";
import { isClipIdeaNotes, pickSourceCaption } from "./source-caption";

// Shape written by buildContentBody (promote-clip-idea.ts) on every clip.
const NOTES = [
  "Source: How to Earn Respect in Sales",
  "Timestamp: 02:46–03:15 (29s)",
  "",
  "Angle: Always-on availability reads as low status",
  "",
  "Why: Strong contrarian opener",
].join("\n");

describe("isClipIdeaNotes", () => {
  it("recognises the clip-idea notes block", () => {
    expect(isClipIdeaNotes(NOTES)).toBe(true);
  });
  it("leaves a real caption alone, even one that mentions a source", () => {
    expect(isClipIdeaNotes("Source: trust me, this works.\n\nFollow for more")).toBe(false);
    expect(isClipIdeaNotes("Being relatable goes a long way in sales.")).toBe(false);
    expect(isClipIdeaNotes(null)).toBe(false);
  });
});

describe("pickSourceCaption", () => {
  it("uses the source's body when it is a real caption", () => {
    expect(pickSourceCaption("live caption", "draft caption")).toBe("live caption");
  });
  it("uses the source's draft caption when the body is clip-idea notes", () => {
    expect(pickSourceCaption(NOTES, "Being relatable goes a long way.")).toBe(
      "Being relatable goes a long way.",
    );
  });
  it("uses the draft caption when the body is empty", () => {
    expect(pickSourceCaption("  ", "draft caption")).toBe("draft caption");
    expect(pickSourceCaption(null, "draft caption")).toBe("draft caption");
  });
  it("never returns the notes, even when the draft holds them too", () => {
    expect(pickSourceCaption(NOTES, NOTES)).toBeNull();
    expect(pickSourceCaption(NOTES, null)).toBeNull();
  });
});
