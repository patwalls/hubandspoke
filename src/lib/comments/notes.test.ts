import { describe, it, expect } from "vitest";
import { isOpenNote, openNotesLabel } from "./notes";

describe("open review notes", () => {
  it("counts only pinned notes nobody has marked done", () => {
    expect(isOpenNote({ atSeconds: 12, resolvedAt: null })).toBe(true);
    expect(isOpenNote({ atSeconds: 0, resolvedAt: null })).toBe(true);
    expect(isOpenNote({ atSeconds: 12, resolvedAt: "2026-10-28T12:00:00Z" })).toBe(false);
    // Plain comments are conversation, not a to-do — even when open.
    expect(isOpenNote({ atSeconds: null, resolvedAt: null })).toBe(false);
    expect(isOpenNote({ atSeconds: undefined, resolvedAt: undefined })).toBe(false);
  });

  it("labels the count, or nothing when every note is done", () => {
    expect(openNotesLabel([])).toBeNull();
    expect(openNotesLabel([{ atSeconds: 3, resolvedAt: "x" }])).toBeNull();
    expect(openNotesLabel([{ atSeconds: 3, resolvedAt: null }])).toBe("1 open note");
    expect(
      openNotesLabel([
        { atSeconds: 3, resolvedAt: null },
        { atSeconds: 9, resolvedAt: null },
        { atSeconds: null, resolvedAt: null },
      ]),
    ).toBe("2 open notes");
  });
});
