import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { describeTemplate, submissionProblem, TEMPLATE_FRAMING } from "./agent";

const sb = DEFAULT_TEMPLATES["sunday breakfast"];

describe("describeTemplate with examples", () => {
  it("puts each section's past renderings next to its instructions and frames them as the teacher", () => {
    const text = describeTemplate(sb, false, { orange_juice: ["**[$50K app](https://x)**\nTwo lines.", "Second example"], intro: ["Hey!\nThis week."] });
    expect(text).toContain(TEMPLATE_FRAMING);
    expect(text).toContain('key "orange_juice"');
    expect(text).toContain("EXAMPLE 1 (a past issue");
    expect(text).toContain("   | **[$50K app](https://x)**");
    expect(text).toContain("EXAMPLE 2");
    expect(text).toContain("   | Hey!");
    // No examples → no framing block.
    expect(describeTemplate(sb, false, null)).not.toContain(TEMPLATE_FRAMING);
  });

  it("marks optional sections, and the sponsor slot gets no examples when its copy is supplied", () => {
    const t = { ...sb, sections: sb.sections.map((s) => (s.key === "coffee" ? { ...s, optional: true } : s)) };
    const text = describeTemplate(t, true, { special: ["old promo"], coffee: ["Coffee example"] });
    expect(text).toContain('key "coffee" — fixed heading "The Coffee ☕" (added for you; don\'t repeat it) — OPTIONAL');
    expect(text).not.toContain("old promo");
    expect(text).toContain("Coffee example");
  });
});

describe("submissionProblem with optional sections", () => {
  const sub = (keys: string[], empty: string[] = []) => ({
    subject_options: ["a", "b", "c"],
    subject: "a",
    preview_text: "",
    sections: keys.map((key) => ({ key, markdown: empty.includes(key) ? "" : `${key} text` })),
    sources: [],
  });
  it("accepts an empty optional section but still requires the others", () => {
    const t = { ...sb, sections: sb.sections.map((s) => (s.key === "coffee" ? { ...s, optional: true } : s)) };
    const keys = t.sections.map((s) => s.key);
    expect(submissionProblem(sub(keys, ["coffee"]), t, true)).toBeNull();
    expect(submissionProblem(sub(keys, ["coffee", "eggs"]), t, true)).toMatch(/eggs/);
    expect(submissionProblem(sub(keys, ["coffee"]), sb, true)).toMatch(/coffee/);
  });
});
