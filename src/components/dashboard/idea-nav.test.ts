import { describe, expect, it } from "vitest";
import { ideaNeighbours } from "./idea-nav";

describe("ideaNeighbours", () => {
  it("gives both neighbours in the middle", () => {
    expect(ideaNeighbours(["a", "b", "c"], "b")).toEqual({ position: 2, total: 3, prev: "a", next: "c" });
  });

  it("has no previous on the first row and no next on the last", () => {
    expect(ideaNeighbours(["a", "b", "c"], "a")).toMatchObject({ prev: null, next: "b" });
    expect(ideaNeighbours(["a", "b", "c"], "c")).toMatchObject({ prev: "b", next: null });
  });

  it("shows nothing for a lone idea or one no longer in the list (killed, filtered out)", () => {
    expect(ideaNeighbours(["a"], "a")).toBeNull();
    expect(ideaNeighbours(["a", "b"], "z")).toBeNull();
  });
});
