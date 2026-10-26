import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { describeSectionExamples, sectionExamples, splitIssueSections } from "./exemplars";

const sb = DEFAULT_TEMPLATES["sunday breakfast"];
const issue = (n: number) => ({
  subject: `Issue ${n}`,
  previewText: null,
  publishedAt: `2026-10-0${n}`,
  views: null,
  body: [
    "Hey!",
    `This week ${n}.`,
    "Alright, let's get into Sunday Breakfast!",
    "",
    "## The Orange Juice 🍊",
    `OJ story ${n}.`,
    "Second line.",
    "",
    "The Coffee ☕",
    `Coffee story ${n}.`,
    "",
    "The Special 🍽️",
    "Sponsor copy.",
    "",
    "The Pancakes 🥞",
    `Pancakes ${n}.`,
    "",
    "That's it!",
    "Pat",
  ].join("\n"),
});

describe("splitIssueSections", () => {
  it("cuts an issue at the template's headings (with or without # / emoji noise) and keeps the intro as the preamble", () => {
    const { preamble, sections } = splitIssueSections(issue(1).body, sb.sections.map((s) => s.heading ?? "").filter(Boolean));
    expect(preamble).toContain("This week 1.");
    expect(preamble).not.toContain("OJ story");
    expect(sections.get("the orange juice")).toBe("OJ story 1.\nSecond line.");
    expect(sections.get("the coffee")).toBe("Coffee story 1.");
    // The last headed section runs to the end (the sign-off is inside it — it has no heading of its own).
    expect(sections.get("the pancakes")).toContain("Pancakes 1.");
    expect(sections.has("the eggs")).toBe(false);
  });

  it("doesn't take a heading mentioned mid-sentence as a section break", () => {
    const { sections } = splitIssueSections("Intro mentions The Coffee ☕ in passing and goes on for a while here.\n\nThe Coffee ☕\nReal section.", ["The Coffee ☕"]);
    expect(sections.get("the coffee")).toBe("Real section.");
  });
});

describe("sectionExamples", () => {
  it("gives each located section up to 3 examples, newest first, and skips the sponsor and unlocatable sections", () => {
    const ex = sectionExamples([issue(4), issue(3), issue(2), issue(1)], sb);
    expect(ex.intro).toHaveLength(3);
    expect(ex.intro[0]).toContain("This week 4.");
    expect(ex.orange_juice[0]).toBe("OJ story 4.\nSecond line.");
    expect(ex.special).toBeUndefined();
    expect(ex.eggs).toBeUndefined();
    expect(ex.signoff).toBeUndefined();
  });

  it("a template with no headings (Daily Seinfeld) uses the whole issue as the first section's example", () => {
    const ds = DEFAULT_TEMPLATES["daily seinfeld"];
    const ex = sectionExamples([{ ...issue(1), body: "Read Time: 40 sec.\n\nHook line.\n\nStory." }], ds);
    expect(ex[ds.sections[0].key][0]).toContain("Hook line.");
  });

  it("trims long examples to the budget", () => {
    const long = { ...issue(1), body: `The Orange Juice 🍊\n${"x".repeat(5000)}` };
    const ex = sectionExamples([long], sb);
    expect(ex.orange_juice[0].length).toBeLessThan(2000);
    expect(ex.orange_juice[0].endsWith("…")).toBe(true);
  });
});

describe("describeSectionExamples", () => {
  it("quotes up to two examples as an indented block, null without any", () => {
    expect(describeSectionExamples(undefined)).toBeNull();
    const text = describeSectionExamples(["A\nB", "C", "D"])!;
    expect(text).toContain("EXAMPLE 1");
    expect(text).toContain("   | A\n   | B");
    expect(text).toContain("EXAMPLE 2");
    expect(text).not.toContain("EXAMPLE 3");
  });
});

describe("sections whose heading is a field", () => {
  it("still finds the section in a past issue by the field's sample (\"{steps_heading}\" → \"How We Did It\")", () => {
    const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];
    const issue = { subject: "s", previewText: null, publishedAt: "2026-10-20", views: null, body: "Intro line\n\n- Saj\n\nHow We Did It\n\nHere's how we set it up.\n\n1. Create a project\n\nFree Resource\n\nThe offer." };
    const ex = sectionExamples([issue], fp);
    expect(ex.steps).toEqual(["Here's how we set it up.\n\n1. Create a project"]);
  });
});
