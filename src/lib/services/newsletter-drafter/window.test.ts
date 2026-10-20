import { describe, expect, it } from "vitest";
import { clampWindowDays, computeWindow, isWithinWindow, toolWindow } from "./window";

const NOW = new Date("2026-10-20T12:00:00.000Z");

describe("newsletter drafter window", () => {
  it("defaults to 7 days and clamps out-of-range lookbacks", () => {
    expect(clampWindowDays(undefined)).toBe(7);
    expect(clampWindowDays(Number.NaN)).toBe(7);
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(400)).toBe(31);
  });

  it("ends the window at now", () => {
    const w = computeWindow(7, NOW);
    expect(w.end).toEqual(NOW);
    expect(w.start.toISOString()).toBe("2026-10-13T12:00:00.000Z");
  });

  it("re-anchors an agent's own lookback at the draft's end, not at call time", () => {
    const draft = computeWindow(7, NOW);
    expect(toolWindow(draft, null)).toBe(draft);
    const daily = toolWindow(draft, 1);
    expect(daily.end).toEqual(NOW);
    expect(daily.start.toISOString()).toBe("2026-10-19T12:00:00.000Z");
  });

  it("treats missing or unparseable timestamps as outside the window", () => {
    const w = computeWindow(7, NOW);
    expect(isWithinWindow("2026-10-15T00:00:00Z", w)).toBe(true);
    expect(isWithinWindow("2026-10-01T00:00:00Z", w)).toBe(false);
    expect(isWithinWindow(null, w)).toBe(false);
    expect(isWithinWindow("not a date", w)).toBe(false);
  });
});
