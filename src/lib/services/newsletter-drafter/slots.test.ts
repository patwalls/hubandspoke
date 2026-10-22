import { videoSendDate } from "./slots";
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

  it("schedules Sunday Breakfast Sun, Daily Seinfeld Tue/Thu, and one Futurepedia Newsletter (queue-triggered) for both channels", () => {
    expect(formatConfigFor("Sunday Breakfast").schedule?.days).toEqual([0]);
    expect(formatConfigFor("Daily Seinfeld").schedule?.days).toEqual([2, 4]);
    expect(groupFormatNames("futurepedia-howto")).toEqual(["futurepedia newsletter"]);
    expect(scheduledPrimaries().map((p) => p.formatName)).toContain("futurepedia newsletter");
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

  it("asks for screenshot placeholders only in sections whose template setting is on, in any newsletter", () => {
    expect(describeTemplate(t, true)).not.toContain("SCREENSHOT RULE");
    const withShots = { ...t, sections: t.sections.map((sec, i) => (i === 0 ? { ...sec, screenshots: true } : sec)) };
    const text = describeTemplate(withShots, true);
    expect(text).toContain("SCREENSHOT RULE");
    expect(text.match(/SCREENSHOTS: add screenshot placeholders here/g)).toHaveLength(1);
    expect(text).toContain(`key "${t.sections[0].key}"`);
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

describe("video-triggered How-To send dates", () => {
  // Oct 2026: Mon 19, Tue 20, Wed 21, Thu 22, Fri 23, Sat 24, Sun 25, Mon 26, Tue 27.
  const tueFri = [2, 5];
  const send = (published: string, today: string, taken: string[] = []) => videoSendDate(published, today, tueFri, 3, new Set(taken));

  it("goes out on the next open Tuesday or Friday — a Sunday and a Monday video both go Tuesday", () => {
    expect(send("2026-10-25", "2026-10-25")).toBe("2026-10-27");
    expect(send("2026-10-26", "2026-10-26")).toBe("2026-10-27");
    expect(send("2026-10-24", "2026-10-24")).toBe("2026-10-27");
    expect(send("2026-10-21", "2026-10-21")).toBe("2026-10-23");
  });

  it("takes the next weekday as the week's third send when Tue and Fri are taken, then waits for next week", () => {
    expect(send("2026-10-21", "2026-10-21", ["2026-10-20", "2026-10-23"])).toBe("2026-10-22");
    expect(send("2026-10-22", "2026-10-22", ["2026-10-20", "2026-10-22", "2026-10-23"])).toBe("2026-10-27");
  });

  it("never schedules in the past for a video noticed late", () => {
    expect(send("2026-10-14", "2026-10-21")).toBe("2026-10-23");
  });
});
