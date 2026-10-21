import { describe, expect, it } from "vitest";
import { groupByPillar } from "./group";

const item = (id: string, pillarId: string | null, pillarTitle: string | null = null) => ({
  id,
  pillarId,
  pillarTitle,
});

describe("groupByPillar", () => {
  it("keeps a pillar's posts together in oldest-first group order, loose posts last", () => {
    const groups = groupByPillar([
      item("a", "p2", "Second pillar"),
      item("b", null),
      item("c", "p1", "First pillar"),
      item("d", "p2", "Second pillar"),
    ]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ["Second pillar", ["a", "d"]],
      ["First pillar", ["c"]],
      ["Other posts", ["b"]],
    ]);
  });

  it("names a pillar with no title instead of showing a blank header", () => {
    expect(groupByPillar([item("a", "p1", "  ")])[0].title).toBe("Untitled pillar");
  });
});
