import { describe, it, expect } from "vitest";
import { estimatedProgress } from "./estimated-progress";

describe("estimatedProgress", () => {
  it("starts empty", () => {
    expect(estimatedProgress(0, 20_000)).toBe(0);
  });

  it("is ~85% at the expected duration", () => {
    expect(estimatedProgress(20_000, 20_000)).toBeCloseTo(0.85, 5);
  });

  it("never reaches 100% however long the wait runs", () => {
    expect(estimatedProgress(10 * 60_000, 20_000)).toBeLessThan(0.96);
  });

  it("only ever moves forward", () => {
    let prev = 0;
    for (let t = 250; t <= 60_000; t += 250) {
      const p = estimatedProgress(t, 20_000);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });
});

describe("draftProgress", () => {
  it("starts each phase at its floor, creeps with time, and never passes the next phase's start", async () => {
    const { draftProgress } = await import("./estimated-progress");
    expect(draftProgress("reading", 0)).toBeCloseTo(0.25);
    expect(draftProgress("reading", 30_000)).toBeGreaterThan(0.25);
    expect(draftProgress("reading", 10 * 60_000)).toBeLessThanOrEqual(0.55);
    expect(draftProgress("writing", 0)).toBeGreaterThanOrEqual(draftProgress("reading", 10 * 60_000));
    expect(draftProgress("reviewing", 60 * 60_000)).toBeLessThan(1);
    expect(draftProgress(null, 0)).toBeCloseTo(0.03);
  });
});
