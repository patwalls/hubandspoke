import { describe, it, expect } from "vitest";
import { editorFilterMark, rowsPerEditor, withCount } from "./editor-filter";

describe("rowsPerEditor", () => {
  it("counts rows per editor and skips unassigned rows", () => {
    const counts = rowsPerEditor([
      { editorUserId: "a" },
      { editorUserId: "b" },
      { editorUserId: "a" },
      { editorUserId: null },
      {},
    ]);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.size).toBe(2);
  });
});

describe("withCount", () => {
  it("adds the count when there are rows", () => {
    expect(withCount("Just me", 3)).toBe("Just me · 3");
  });
  it("shows the bare label for zero or unknown", () => {
    expect(withCount("Just me", 0)).toBe("Just me");
    expect(withCount("Just me", undefined)).toBe("Just me");
  });
});

describe("editorFilterMark", () => {
  it("names a pick of yourself, someone else, or everyone", () => {
    expect(editorFilterMark("me-id", "all", "me-id")).toBe("production:editor-filter:me");
    expect(editorFilterMark("other-id", "all", "me-id")).toBe("production:editor-filter:other");
    expect(editorFilterMark("all", "me-id", "me-id")).toBe("production:editor-filter:all");
  });
  it("is silent when the pick didn't change", () => {
    expect(editorFilterMark("me-id", "me-id", "me-id")).toBeNull();
  });
  it("treats any id as other when signed-out", () => {
    expect(editorFilterMark("x", "all", null)).toBe("production:editor-filter:other");
  });
});
