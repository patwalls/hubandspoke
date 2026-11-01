import { describe, it, expect } from "vitest";
import { ReportCache, loadMode } from "./report-cache";

describe("ReportCache", () => {
  it("evicts the least recently used view, not the oldest written", () => {
    const c = new ReportCache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1); // "a" is now the freshest
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    expect(c.size).toBe(2);
  });

  it("overwrites a view with its refreshed report", () => {
    const c = new ReportCache<string>(2);
    c.set("a", "stale");
    c.set("a", "fresh");
    expect(c.get("a")).toBe("fresh");
    expect(c.size).toBe(1);
  });
});

describe("loadMode", () => {
  it("shows a remembered view at once, even with rows on screen", () => {
    expect(loadMode(true, true)).toBe("instant");
    expect(loadMode(true, false)).toBe("instant");
  });
  it("keeps the current rows on a filter change instead of a spinner", () => {
    expect(loadMode(false, true)).toBe("keep");
  });
  it("spins only when there is nothing to show", () => {
    expect(loadMode(false, false)).toBe("spinner");
  });
});
