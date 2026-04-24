import { describe, it, expect } from "vitest";
import {
  VELOCITY_CHECKPOINTS,
  isVelocityCheckpointKey,
} from "./velocity-checkpoints";

describe("VELOCITY_CHECKPOINTS", () => {
  it("has exactly five checkpoints", () => {
    expect(VELOCITY_CHECKPOINTS).toHaveLength(5);
  });

  it("uses the expected keys in the expected order", () => {
    expect(VELOCITY_CHECKPOINTS.map((c) => c.key)).toEqual([
      "15m",
      "30m",
      "1h",
      "2h",
      "4h",
    ]);
  });

  it("has monotonically increasing offsetMinutes", () => {
    for (let i = 1; i < VELOCITY_CHECKPOINTS.length; i++) {
      expect(VELOCITY_CHECKPOINTS[i].offsetMinutes).toBeGreaterThan(
        VELOCITY_CHECKPOINTS[i - 1].offsetMinutes
      );
    }
  });

  it("each checkpoint's target is inside its window", () => {
    for (const cp of VELOCITY_CHECKPOINTS) {
      expect(cp.windowMin).toBeLessThanOrEqual(cp.offsetMinutes);
      expect(cp.windowMax).toBeGreaterThanOrEqual(cp.offsetMinutes);
      expect(cp.windowMin).toBeGreaterThanOrEqual(0);
    }
  });

  it("adjacent windows do not overlap (no snapshot can be ambiguous)", () => {
    for (let i = 1; i < VELOCITY_CHECKPOINTS.length; i++) {
      expect(VELOCITY_CHECKPOINTS[i].windowMin).toBeGreaterThan(
        VELOCITY_CHECKPOINTS[i - 1].windowMax
      );
    }
  });
});

describe("isVelocityCheckpointKey", () => {
  it("accepts every valid key", () => {
    for (const cp of VELOCITY_CHECKPOINTS) {
      expect(isVelocityCheckpointKey(cp.key)).toBe(true);
    }
  });

  it("rejects null and undefined", () => {
    expect(isVelocityCheckpointKey(null)).toBe(false);
    expect(isVelocityCheckpointKey(undefined)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isVelocityCheckpointKey("")).toBe(false);
  });

  it("rejects close-but-wrong values", () => {
    expect(isVelocityCheckpointKey("3h")).toBe(false);
    expect(isVelocityCheckpointKey("15min")).toBe(false);
    expect(isVelocityCheckpointKey("1H")).toBe(false);
    expect(isVelocityCheckpointKey("1h ")).toBe(false);
    expect(isVelocityCheckpointKey("60m")).toBe(false);
  });

  it("rejects arbitrary strings", () => {
    expect(isVelocityCheckpointKey("nonsense")).toBe(false);
    expect(isVelocityCheckpointKey("drop table")).toBe(false);
  });
});
