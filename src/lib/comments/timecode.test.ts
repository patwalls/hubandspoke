import { describe, it, expect } from "vitest";
import { formatTimecode, parseAtSeconds, MAX_AT_SECONDS } from "./timecode";

describe("formatTimecode", () => {
  it("floors to the second so the chip never claims a moment not yet reached", () => {
    expect(formatTimecode(12.9)).toBe("0:12");
    expect(formatTimecode(75.9)).toBe("1:15");
  });
  it("adds hours only past the hour, with padded minutes", () => {
    expect(formatTimecode(3599)).toBe("59:59");
    expect(formatTimecode(3723)).toBe("1:02:03");
  });
  it("clamps negatives to 0:00", () => {
    expect(formatTimecode(-3)).toBe("0:00");
  });
});

describe("parseAtSeconds", () => {
  it("treats a missing value as no timecode", () => {
    expect(parseAtSeconds(undefined)).toBeNull();
    expect(parseAtSeconds(null)).toBeNull();
  });
  it("rounds to a tenth of a second", () => {
    expect(parseAtSeconds(12.345)).toBe(12.3);
    expect(parseAtSeconds(0)).toBe(0);
  });
  it("rejects strings, NaN, negatives and absurd lengths", () => {
    expect(parseAtSeconds("12")).toBeUndefined();
    expect(parseAtSeconds(Number.NaN)).toBeUndefined();
    expect(parseAtSeconds(-1)).toBeUndefined();
    expect(parseAtSeconds(MAX_AT_SECONDS + 1)).toBeUndefined();
  });
});
