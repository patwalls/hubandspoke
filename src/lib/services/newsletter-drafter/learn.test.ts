import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { applyProposal, buildLearnPrompt, type LearnedProposal } from "./learn";

const sb = DEFAULT_TEMPLATES["sunday breakfast"];

describe("applyProposal", () => {
  const proposal: LearnedProposal = {
    style_notes: "Pat writes like he talks: short lines, one idea each, a '^^^' callback now and then. Subjects are the lead story's number.",
    rationale: "Kept the courses; the Coffee is optional (missing in 3 of 8 issues); added a PS.",
    sections: [
      { key: "intro", heading: null, hint: "Hey! then 3-6 short lines on Pat's week.", story: "none" },
      { key: "orange_juice", heading: "The Orange Juice 🍊", hint: "The flagship video: headline link, 2 short paragraphs, a watch link.", story: "newest_video" },
      { key: "coffee", heading: "The Coffee ☕", hint: "A second video, shorter.", story: "newest_video", optional: true },
      { key: "special", heading: "The Special 🍽️", hint: "The sponsor.", kind: "sponsor", link_buttons: true },
      // Same section as "eggs" but renamed key: matched by heading, keeps the key and its pill.
      { key: "the_eggs", heading: "The Eggs 🍳", hint: "A case study.", story: "case_study" },
      { key: "ps", heading: null, hint: "A one-line PS with a link to something Pat liked.", story: "none", optional: true },
    ],
  };

  it("keeps each matched section's key, pill and settings, adds new ones with defaults, and records the learning", () => {
    const t = applyProposal(sb, proposal, 8, new Date("2026-10-23T12:00:00Z"));
    expect(t.sections.map((s) => s.key)).toEqual(["intro", "orange_juice", "coffee", "special", "eggs", "ps"]);
    const oj = t.sections.find((s) => s.key === "orange_juice")!;
    expect(oj.pillColor).toBe("#fed7aa"); // kept from the current template
    expect(oj.hint).toBe("The flagship video: headline link, 2 short paragraphs, a watch link.");
    expect(oj.story).toBe("newest_video");
    expect(t.sections.find((s) => s.key === "coffee")!.optional).toBe(true);
    const eggs = t.sections.find((s) => s.key === "eggs")!;
    expect(eggs.pillColor).toBe("#fef9c3");
    const special = t.sections.find((s) => s.key === "special")!;
    expect(special.kind).toBe("sponsor");
    expect(special.boxColor).toBe("#EBECFC");
    expect(special.linkButtons).toBe(true);
    const ps = t.sections.find((s) => s.key === "ps")!;
    expect(ps.pillColor).toBeNull();
    expect(ps.optional).toBe(true);
    expect(t.styleNotes).toContain("short lines");
    expect(t.learnedFrom).toBe(8);
    expect(t.learnedAt).toBe("2026-10-23T12:00:00.000Z");
    // The look and the HubSpot link stay.
    expect(t.style).toEqual(sb.style);
    expect(t.hubspot).toEqual(sb.hubspot);
  });

  it("keeps the current sponsor slot when the proposal forgot it, and allows only one sponsor", () => {
    const without = { ...proposal, sections: proposal.sections.filter((s) => s.kind !== "sponsor") };
    const t = applyProposal(sb, without, 5);
    expect(t.sections.filter((s) => s.kind === "sponsor")).toHaveLength(1);
    expect(t.sections.findIndex((s) => s.kind === "sponsor")).toBe(3); // where it sits today
    const two = { ...proposal, sections: [...proposal.sections, { key: "promo", heading: "Promo", hint: "x", kind: "sponsor" as const }] };
    expect(applyProposal(sb, two, 5).sections.filter((s) => s.kind === "sponsor")).toHaveLength(1);
  });

  it("normalizes keys the model wrote and keeps them unique", () => {
    const t = applyProposal(sb, { ...proposal, sections: [{ key: "Quick Hits!", heading: "Quick Hits", hint: "x" }, { key: "quick-hits", heading: "Quick Hits 2", hint: "y" }] }, 3);
    expect(t.sections.map((s) => s.key)).toEqual(["quick_hits", "quick_hits_2", "special"]);
  });
});

describe("buildLearnPrompt", () => {
  it("carries the current template, the Skill, every issue and the case-study rule for the brand", () => {
    const p = buildLearnPrompt({
      formatName: "Sunday Breakfast",
      brandLabel: "Starter Story",
      skill: "## Voice\nPat.",
      current: sb,
      issues: [{ subject: "S1", previewText: "P1", publishedAt: "2026-10-19T00:00:00Z", views: null, body: "Hey!\nBody 1" }],
      caseStudies: true,
    });
    expect(p).toContain('key "orange_juice"');
    expect(p).toContain("## Voice");
    expect(p).toContain("Subject: S1");
    expect(p).toContain("Body 1");
    expect(p).toContain("this brand has them");
    expect(buildLearnPrompt({ formatName: "x", brandLabel: "y", skill: null, current: sb, issues: [], caseStudies: false })).toContain("don't use it");
  });
});
