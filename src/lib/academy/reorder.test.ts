import { describe, expect, it } from "vitest";
import type { AcademyCategory, AcademyVideo } from "@/lib/academy/queries";
import { moveCategory, moveVideo } from "./reorder";

const v = (id: string, categoryId: string) => ({ id, categoryId, slug: id, title: id }) as AcademyVideo;
const lib = (): AcademyCategory[] => [
  { id: "A", name: "A", description: null, videos: [v("a1", "A"), v("a2", "A"), v("a3", "A")] },
  { id: "B", name: "B", description: null, videos: [v("b1", "B")] },
  { id: "C", name: "C", description: null, videos: [] },
];
const ids = (l: AcademyCategory[]) => l.map((c) => `${c.id}:${c.videos.map((x) => x.id).join(",")}`);

describe("moveVideo", () => {
  it("moves down and up within a category (drop position measured before removal)", () => {
    expect(ids(moveVideo(lib(), "a1", "A", 3))).toEqual(["A:a2,a3,a1", "B:b1", "C:"]);
    expect(ids(moveVideo(lib(), "a1", "A", 2))).toEqual(["A:a2,a1,a3", "B:b1", "C:"]);
    expect(ids(moveVideo(lib(), "a3", "A", 0))).toEqual(["A:a3,a1,a2", "B:b1", "C:"]);
  });

  it("moves into another category, including an empty one, and updates its categoryId", () => {
    const out = moveVideo(lib(), "a2", "B", 0);
    expect(ids(out)).toEqual(["A:a1,a3", "B:a2,b1", "C:"]);
    expect(out[1].videos[0].categoryId).toBe("B");
    expect(ids(moveVideo(lib(), "b1", "C", 0))).toEqual(["A:a1,a2,a3", "B:", "C:b1"]);
  });

  it("ignores unknown ids", () => {
    expect(ids(moveVideo(lib(), "zz", "A", 0))).toEqual(ids(lib()));
    expect(ids(moveVideo(lib(), "a1", "ZZ", 0))).toEqual(ids(lib()));
  });
});

describe("moveCategory", () => {
  it("reorders categories", () => {
    expect(moveCategory(lib(), "A", 3).map((c) => c.id)).toEqual(["B", "C", "A"]);
    expect(moveCategory(lib(), "C", 0).map((c) => c.id)).toEqual(["C", "A", "B"]);
    expect(moveCategory(lib(), "B", 1).map((c) => c.id)).toEqual(["A", "B", "C"]);
  });
});
