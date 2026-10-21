import { describe, expect, it } from "vitest";
import { describeTemplate, submissionProblem, type NewsletterSubmission } from "./agent";
import { formatConfigFor, groupFormatNames, scheduledPrimaries, upcomingSendDates } from "./format-config";
import { spliceSection } from "./section";
import { slotKeyFor, slotWindow } from "./slots";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";

describe("newsletter schedules", () => {
  it("lists the next two weeks of send dates on the schedule's weekdays, starting tomorrow", () => {
    // 2026-10-20 is a Tuesday.
    const now = new Date("2026-10-20T15:00:00Z");
    expect(upcomingSendDates([0], 14, now)).toEqual(["2026-10-25", "2026-11-01"]);
    expect(upcomingSendDates([2, 4], 14, now)).toEqual(["2026-10-22", "2026-10-27", "2026-10-29", "2026-11-03"]);
  });

  it("schedules Sunday Breakfast Sun, Daily Seinfeld Tue/Thu and one shared Tuesday How-To across both channels", () => {
    expect(formatConfigFor("Sunday Breakfast").schedule?.days).toEqual([0]);
    expect(formatConfigFor("Daily Seinfeld").schedule?.days).toEqual([2, 4]);
    expect(groupFormatNames("futurepedia-howto")).toHaveLength(2);
    const primaries = scheduledPrimaries().map((p) => p.formatName);
    expect(primaries).toContain("how-to newsletter - futurepedia (pilot)");
    expect(primaries).not.toContain("how-to newsletter - skill leap (pilot)");
  });

  it("keys a slot by group + date and gives roundups the week before the send date", () => {
    expect(slotKeyFor("sunday-breakfast", "2026-10-25")).toBe("sunday-breakfast:2026-10-25");
    const w = slotWindow("2026-10-25");
    expect(w.start.toISOString()).toBe("2026-10-18T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
});

describe("templated submissions", () => {
  const t = DEFAULT_TEMPLATES["sunday breakfast"];
  const full = (overrides: Record<string, string> = {}) =>
    t.sections.map((s) => ({ key: s.key, markdown: overrides[s.key] ?? `content for ${s.key}` }));
  const sub = (sections: Array<{ key: string; markdown: string }>): NewsletterSubmission => ({
    subject_options: ["a", "b", "c"],
    subject: "a",
    preview_text: "p",
    sections,
    sources: [],
  });

  it("requires every section, rejects unknown keys, and lets the sponsor section be empty only when the promo supplies it", () => {
    expect(submissionProblem(sub(full()), t, false)).toBeNull();
    expect(submissionProblem(sub([...full(), { key: "extra", markdown: "x" }]), t, false)).toMatch(/Unknown section keys: extra/);
    expect(submissionProblem(sub(full({ coffee: "" })), t, false)).toMatch(/coffee/);
    expect(submissionProblem(sub(full({ special: "" })), t, false)).toMatch(/special/);
    expect(submissionProblem(sub(full({ special: "" })), t, true)).toBeNull();
  });

  it("tells the model which sections are fixed-heading and which one the promo calendar fills", () => {
    const text = describeTemplate(t, true);
    expect(text).toContain('key "orange_juice" — fixed heading "The Orange Juice 🍊"');
    expect(text).toContain('key "special"');
    expect(text).toContain("SUPPLIED BY THE PROMO CALENDAR");
  });

  it("splices one regenerated section without touching the others", () => {
    const sections = [
      { key: "a", markdown: "1" },
      { key: "b", markdown: "2" },
    ];
    expect(spliceSection(sections, "b", "new")).toEqual([{ key: "a", markdown: "1" }, { key: "b", markdown: "new" }]);
    expect(spliceSection(sections, "c", "3")).toHaveLength(3);
  });
});
