import { describe, expect, it } from "vitest";
import { nextOpenId } from "./next-open";

describe("nextOpenId", () => {
  const order = ["a", "b", "c", "d"];

  it("moves to the next row that still needs a link", () => {
    expect(nextOpenId(order, "a", { a: "x", b: "y" })).toBe("c");
  });

  it("wraps to a row above that was skipped", () => {
    expect(nextOpenId(order, "c", { b: "y", c: "z", d: "w" })).toBe("a");
  });

  it("is null when every row is done", () => {
    expect(nextOpenId(order, "b", { a: 1, b: 1, c: 1, d: 1 })).toBeNull();
  });

  it("is null for a row it doesn't know", () => {
    expect(nextOpenId(order, "zz", {})).toBeNull();
  });
});
