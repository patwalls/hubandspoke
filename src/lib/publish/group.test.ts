import { describe, expect, it } from "vitest";
import { focusGroupFirst, groupByPillar } from "./group";

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

describe("focusGroupFirst", () => {
  const groups = groupByPillar([
    item("a", "p1", "First"),
    item("b", "p2", "Second"),
    item("c", null),
    item("d", "p2", "Second"),
  ]);
  const keys = (gs: { key: string }[]) => gs.map((g) => g.key);

  it("moves the group holding the focused post to the top, rest in order", () => {
    expect(keys(focusGroupFirst(groups, "d"))).toEqual(["p2", "p1", "other"]);
    expect(keys(focusGroupFirst(groups, "c"))).toEqual(["other", "p1", "p2"]);
  });

  it("leaves the order alone for no id, an unknown id, or a post already on top", () => {
    expect(keys(focusGroupFirst(groups, null))).toEqual(["p1", "p2", "other"]);
    expect(keys(focusGroupFirst(groups, "gone"))).toEqual(["p1", "p2", "other"]);
    expect(keys(focusGroupFirst(groups, "a"))).toEqual(["p1", "p2", "other"]);
  });
});
