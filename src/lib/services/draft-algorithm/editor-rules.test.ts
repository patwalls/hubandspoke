import { describe, it, expect } from "vitest";
import { parseEditorRules, rulesAreStale } from "./editor-rules";

describe("parseEditorRules", () => {
  it("keeps trimmed strings and strips list markers the model adds", () => {
    expect(parseEditorRules(["- Open with the name.", "2) Cut 'just'.", "  Split long hooks  "])).toEqual([
      "Open with the name.",
      "Cut 'just'.",
      "Split long hooks",
    ]);
  });

  it("drops duplicates, non-strings, empties and essays; caps at five", () => {
    const long = "x".repeat(201);
    expect(
      parseEditorRules(["A.", "a.", 3, "", long, "B.", "C.", "D.", "E.", "F."]),
    ).toEqual(["A.", "B.", "C.", "D.", "E."]);
  });

  it("returns [] for anything that isn't a list", () => {
    expect(parseEditorRules(null)).toEqual([]);
    expect(parseEditorRules("Open with the name.")).toEqual([]);
  });
});

describe("rulesAreStale", () => {
  const now = new Date("2026-11-09T14:00:00Z");
  const at = (iso: string) => ({ rules: ["A."], pairCount: 5, generatedAt: iso, model: "m" });

  it("refreshes missing or unreadable rules", () => {
    expect(rulesAreStale(null, now)).toBe(true);
    expect(rulesAreStale(at("not a date"), now)).toBe(true);
  });

  it("leaves rules from this week alone; the daily run picks them up a week later", () => {
    expect(rulesAreStale(at("2026-11-08T14:00:00Z"), now)).toBe(false);
    expect(rulesAreStale(at("2026-11-03T14:00:00Z"), now)).toBe(false); // 6 days
    expect(rulesAreStale(at("2026-11-02T14:00:00Z"), now)).toBe(true); // 7 days
  });
});
