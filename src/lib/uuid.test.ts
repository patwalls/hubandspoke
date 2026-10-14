import { describe, it, expect } from "vitest";
import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("3f1c2a9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(isUuid("3F1C2A9E-8B7D-4E6F-9A0B-1C2D3E4F5A6B")).toBe(true);
  });

  it("rejects a uuid with markdown-bold residue (HUBANDSPOKE-38)", () => {
    expect(isUuid("3f1c2a9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b**")).toBe(false);
  });

  it("rejects non-uuid strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("new")).toBe(false);
    expect(isUuid("3f1c2a9e8b7d4e6f9a0b1c2d3e4f5a6b")).toBe(false);
  });
});
