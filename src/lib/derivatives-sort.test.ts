import { describe, it, expect } from "vitest";
import {
  parseDerivativesSort,
  sortDerivativeRows,
  toggleDerivativesSort,
} from "./derivatives-sort";

const row = (id: string, views: number | null, publishedDate: string | null = null, likes: number | null = null) => ({
  id,
  views,
  likes,
  comments: null,
  publishedDate,
});

describe("sortDerivativeRows", () => {
  const rows = [
    row("clip-a", 1200, "2026-11-20"),
    row("idea", null, null),
    row("clip-b", 54000, "2026-11-18"),
    row("cross-post", 800, "2026-11-22"),
    row("clip-c", 54000, "2026-11-19"),
  ];

  it("keeps the tab's own order by default", () => {
    expect(sortDerivativeRows(rows, "default").map((r) => r.id)).toEqual([
      "clip-a",
      "idea",
      "clip-b",
      "cross-post",
      "clip-c",
    ]);
  });

  it("puts the most-viewed first, ties in original order, unpublished last", () => {
    expect(sortDerivativeRows(rows, "views").map((r) => r.id)).toEqual([
      "clip-b",
      "clip-c",
      "clip-a",
      "cross-post",
      "idea",
    ]);
  });

  it("sorts by publish date newest first, with no date last", () => {
    expect(sortDerivativeRows(rows, "published").map((r) => r.id)).toEqual([
      "cross-post",
      "clip-a",
      "clip-c",
      "clip-b",
      "idea",
    ]);
  });

  it("treats a 0 as a real number, not a missing one", () => {
    const r = [row("none", null), row("zero", 0), row("some", 5)];
    expect(sortDerivativeRows(r, "views").map((x) => x.id)).toEqual(["some", "zero", "none"]);
  });

  it("does not reorder the array it was given", () => {
    const copy = [...rows];
    sortDerivativeRows(rows, "views");
    expect(rows).toEqual(copy);
  });
});

describe("toggleDerivativesSort", () => {
  it("switches to the clicked column, and back to default on a second click", () => {
    expect(toggleDerivativesSort("default", "views")).toBe("views");
    expect(toggleDerivativesSort("likes", "views")).toBe("views");
    expect(toggleDerivativesSort("views", "views")).toBe("default");
  });
});

describe("parseDerivativesSort", () => {
  it("reads a stored choice and falls back to default for junk", () => {
    expect(parseDerivativesSort("views")).toBe("views");
    expect(parseDerivativesSort("published")).toBe("published");
    expect(parseDerivativesSort("rank")).toBe("default");
    expect(parseDerivativesSort(null)).toBe("default");
  });
});
