import { describe, it, expect } from "vitest";
import { defaultCrossPostRules } from "./cross-post-defaults";

describe("defaultCrossPostRules", () => {
  it("X and Threads reposts use the hook verbatim, no link", () => {
    for (const pt of ["x", "threads"]) {
      const r = defaultCrossPostRules(pt)!;
      expect(r).toContain("word for word");
      expect(r).toContain("no link");
    }
  });

  it("says the format's own notes win over the defaults", () => {
    expect(defaultCrossPostRules("linkedin")).toMatch(/follow them instead/);
  });

  it("no default for surfaces we have no rule for", () => {
    expect(defaultCrossPostRules("newsletter")).toBeNull();
    expect(defaultCrossPostRules(null)).toBeNull();
  });
});
