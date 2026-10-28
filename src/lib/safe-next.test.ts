import { describe, it, expect } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps a same-site path with its query", () => {
    expect(safeNext("/my-work/answer/abc?a=approve")).toBe("/my-work/answer/abc?a=approve");
  });

  it("falls back to home for anything that could leave the site", () => {
    for (const raw of [null, undefined, "", "https://evil.com", "//evil.com/x", "/\\evil.com", "javascript:alert(1)"]) {
      expect(safeNext(raw)).toBe("/");
    }
  });
});
