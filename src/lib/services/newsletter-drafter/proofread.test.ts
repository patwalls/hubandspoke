import { describe, expect, it } from "vitest";
import { applicableFixes, applyFixes } from "./proofread";

const sections = [
  { key: "intro", markdown: "Hey!\n\nThis week I spent two two days insdie a dashboard." },
  { key: "coffee", markdown: "Coffee coffee." },
];

describe("proofread fixes", () => {
  it("keeps only fixes whose text occurs exactly once in their section, and applies them once", () => {
    const fixes = [
      { sectionKey: "intro", find: "two two days", replace: "two days", why: "doubled word" },
      { sectionKey: "intro", find: "insdie", replace: "inside", why: "typo" },
      { sectionKey: "intro", find: "nowhere", replace: "x", why: "missing" },
      { sectionKey: "coffee", find: "offee", replace: "o", why: "ambiguous: occurs twice" },
      { sectionKey: "intro", find: "Hey!", replace: "Hey!", why: "no-op" },
    ];
    const ok = applicableFixes(fixes, sections);
    expect(ok.map((f) => f.find)).toEqual(["two two days", "insdie"]);
    const out = applyFixes(sections, ok);
    expect(out[0].markdown).toBe("Hey!\n\nThis week I spent two days inside a dashboard.");
    expect(out[1]).toBe(sections[1]); // untouched section keeps its identity
  });
});
