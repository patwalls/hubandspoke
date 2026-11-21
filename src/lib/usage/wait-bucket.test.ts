import { describe, it, expect } from "vitest";
import { waitBucket } from "./wait-bucket";

describe("waitBucket", () => {
  it("splits at 1 s and 3 s, with each edge in the slower bucket", () => {
    expect(waitBucket(0)).toBe("under-1s");
    expect(waitBucket(999)).toBe("under-1s");
    expect(waitBucket(1_000)).toBe("1-3s");
    expect(waitBucket(2_999)).toBe("1-3s");
    expect(waitBucket(3_000)).toBe("3s-plus");
    expect(waitBucket(60_000)).toBe("3s-plus");
  });

  it("never invents a slow wait from a broken clock", () => {
    expect(waitBucket(Number.NaN)).toBe("under-1s");
    expect(waitBucket(-5)).toBe("under-1s");
  });
});
