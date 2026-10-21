import { describe, expect, it } from "vitest";
import { frameCandidateSecs } from "./screenshots";

describe("frameCandidateSecs", () => {
  it("grabs just before, on, and just after the moment, never before 0:00", () => {
    expect(frameCandidateSecs(272)).toEqual([270, 272, 275]);
    expect(frameCandidateSecs(1)).toEqual([0, 1, 4]);
  });
});
