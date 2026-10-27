import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATES } from "@/lib/newsletter-template";
import { ANGLE_STORY_TEST, buildUserTurn, describeFields, describePillar, describeTemplate, phaseFor, submissionProblem, TEMPLATE_FRAMING, THUMBNAIL_RULE } from "./agent";

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
    // The framing (skeleton fixed, the filling is the issue's call) is there with or without examples.
    expect(describeTemplate(sb, false, null)).toContain(TEMPLATE_FRAMING);
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

describe("a roundup about one piece of pillar content", () => {
  const pillar = { productionItemId: "p1", title: "The $50K app", url: "https://youtu.be/x", thumbnailUrl: null, publishedAt: "2026-10-20T00:00:00Z", transcript: "[0:01] hello", truncated: false, timestamped: true };
  it("puts the video and its transcript in the turn and says every story section draws on it", () => {
    const text = describePillar(pillar);
    expect(text).toContain("ONE PIECE OF PILLAR CONTENT");
    expect(text).toContain('VIDEO: "The $50K app"');
    expect(text).toContain("[0:01] hello");
  });
  it("lets the pillar appear in several sections and never counts it as blocked", () => {
    const keys = sb.sections.map((s) => s.key);
    const sub = {
      subject_options: ["a", "b", "c"],
      subject: "a",
      preview_text: "",
      sections: keys.map((key) => ({ key, markdown: `${key} text`, source: key === "orange_juice" || key === "coffee" ? { kind: "video" as const, production_item_id: "p1" } : null })),
      sources: [],
    };
    const blocked = new Set(["video:p1"]);
    expect(submissionProblem(sub, sb, true, blocked)).toMatch(/last|same story/);
    expect(submissionProblem(sub, sb, true, blocked, "video:p1")).toBeNull();
  });
});

describe("phaseFor (the editor's progress bar)", () => {
  it("maps the tools a turn called to the run's phase", () => {
    expect(phaseFor(["list_recent_videos", "list_recent_case_studies"], false)).toEqual({ phase: "gathering", detail: "Finding stories" });
    expect(phaseFor(["get_video_transcript", "get_video_transcript", "web_fetch"], false)).toEqual({ phase: "reading", detail: "Reading 2 transcripts and 1 page" });
    expect(phaseFor([], false)).toEqual({ phase: "writing", detail: "Writing" });
    expect(phaseFor(["submit_newsletter"], false)).toEqual({ phase: "reviewing", detail: "Reviewing its own draft" });
    expect(phaseFor(["get_video_transcript"], true)).toEqual({ phase: "reviewing", detail: "Revising" });
  });
});

describe("pinnedStoryInstruction (Find new story → the editor picked one)", () => {
  it("names the story, how to read it, and the source to set", async () => {
    const { pinnedStoryInstruction } = await import("./agent");
    const v = pinnedStoryInstruction({ kind: "video", key: "video:abc", title: "The $50K app", url: "https://youtu.be/x", productionItemId: "abc" }, "shorter");
    expect(v).toContain('"The $50K app"');
    expect(v).toContain("get_video_transcript (production_item_id abc)");
    expect(v).toContain("The editor's steer: shorter");
    const c = pinnedStoryInstruction({ kind: "case_study", key: "case:/stories/x", title: "X", url: "https://www.starterstory.com/stories/x", productionItemId: null });
    expect(c).toContain("read_case_study (https://www.starterstory.com/stories/x)");
  });
});

describe("template fields in the drafter's prompt and submission", () => {
  const fp = DEFAULT_TEMPLATES["futurepedia newsletter"];

  it("lists every field with where it sits in the design, its sample and its guidance; a template without fields gets none", () => {
    const { names, text } = describeFields(fp);
    expect(names).toEqual(["tool", "steps_heading", "closer_1", "closer_2"]);
    expect(text).toContain('- tool (appears in "{tool} Guide", "{tool} Guide Continued"; e.g. "ChatGPT Work"): The tool\'s short name');
    expect(text).toContain('- steps_heading (appears in "{steps_heading}"; e.g. "How We Did It")');
    expect(describeFields(sb)).toEqual({ names: [], text: null });
    const prompt = describeTemplate(fp, true, null);
    expect(prompt).toContain("TEMPLATE FIELDS");
    expect(prompt).toContain('key "steps" — heading "{steps_heading}" (drawn for you from the field steps_heading; don\'t repeat it)');
    expect(prompt).toContain(THUMBNAIL_RULE);
    expect(describeTemplate(sb, false, null)).not.toContain("TEMPLATE FIELDS");
  });

  it("a submission is rejected until every field has a value", () => {
    const base = {
      subject_options: ["a", "b", "c"],
      subject: "a",
      preview_text: "p",
      sources: [],
      sections: fp.sections.filter((s) => s.kind !== "sponsor").map((s) => ({ key: s.key, markdown: "x" })),
    };
    const fields = describeFields(fp).names;
    expect(submissionProblem(base, fp, true, undefined, null, fields)).toMatch(/fields need a value in variables: tool, steps_heading, closer_1, closer_2/);
    expect(submissionProblem({ ...base, variables: { tool: "Claude", steps_heading: "How We Did It", closer_1: " ", closer_2: "Bonus Tips" } }, fp, true, undefined, null, fields)).toMatch(/closer_1/);
    expect(submissionProblem({ ...base, variables: { tool: "Claude", steps_heading: "How We Did It", closer_1: "Use Cases", closer_2: "Bonus Tips" } }, fp, true, undefined, null, fields)).toBeNull();
    // A template with no fields asks for none.
    expect(submissionProblem({ ...base, sections: sb.sections.map((s) => ({ key: s.key, markdown: "x" })) }, sb, true, undefined, null, [])).toBeNull();
  });
});

describe("an angle that themes the stories", () => {
  const plan = {
    sections: [{ sectionKey: "orange_juice", story: "newest_video" as const, pick: { kind: "video" as const, key: "video:v1", title: "Habit tracker", url: "https://youtu.be/v1", publishedAt: "2026-10-25T00:00:00Z", productionItemId: "v1" } }],
    caseStudies: [],
    videos: [],
  };
  const args = {
    brand: "Starter Story",
    formatName: "Sunday Breakfast",
    window: { start: new Date("2026-10-13T00:00:00Z"), end: new Date("2026-10-27T00:00:00Z") },
    template: sb,
    storyPlan: plan,
    notes: "Cover businesses that won't be displaced by AI.",
  } as unknown as Parameters<typeof buildUserTurn>[0];

  // 2026-10-27: the date-picked lead (an AI-built habit tracker) stayed in and
  // its section teased the fit instead of stating it.
  it("makes every story pass the angle and say why, and tells the drafter the lineup predates the angle", () => {
    const text = buildUserTurn(args);
    expect(text).toContain(ANGLE_STORY_TEST);
    expect(text).toMatch(/picked by date, BEFORE anyone read THE ANGLE/);
    expect(text).toMatch(/never tease the reason the story is in this issue/);
    expect(text).toMatch(/Swap any story that doesn't earn its place/);
  });

  it("leaves the lineup as a plain suggestion when there is no angle", () => {
    const text = buildUserTurn({ ...args, notes: null });
    expect(text).not.toContain(ANGLE_STORY_TEST);
    expect(text).not.toMatch(/BEFORE anyone read THE ANGLE/);
  });
});
