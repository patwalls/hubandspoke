import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildFormatSkill, buildSkillUserText, plainSkillText } from "./build-format-skill";

function fakeClient(input: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({ content: [{ type: "tool_use", name: "return_skill", input }] });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe("buildSkillUserText", () => {
  it("includes only answered questions and the existing Skill", () => {
    const text = buildSkillUserText({
      family: "clip",
      kindLabel: "Instagram Reel",
      answers: [
        { question: "How should the caption be formatted?", answer: "No hashtags." },
        { question: "How long should clips be?", answer: "   " },
      ],
      existing: "This format is a reel.",
      imageCount: 0,
    });
    expect(text).toContain("Instagram Reel");
    expect(text).toContain("A: No hashtags.");
    expect(text).not.toContain("How long should clips be?");
    expect(text).toContain("This format is a reel.");
    expect(text).toContain("suggest one");
  });
});

describe("buildSkillUserText — from examples", () => {
  it("tells the AI the screenshots are the whole brief", () => {
    const text = buildSkillUserText({ family: "design", kindLabel: "Instagram carousel / image post", answers: [], imageCount: 3, fromExamples: true });
    expect(text).toContain("3 screenshots");
    expect(text).toContain("the screenshots ARE the brief");
  });

  it("works from screenshots alone, without calling it nothing-to-go-on", async () => {
    const { client, create } = fakeClient({ skill: "Captions are short.", suggested_name: "Quote Carousel" });
    const r = await buildFormatSkill({
      family: "design",
      kindLabel: "X post",
      answers: [],
      images: [{ mediaType: "image/png", dataB64: "AAAA" }],
      fromExamples: true,
      client,
    });
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("buildFormatSkill — the examples' clip look", () => {
  const img = [{ mediaType: "image/png", dataB64: "AAAA" }];
  it("asks for and returns the look for a clip format built from examples", async () => {
    const look = { aspectRatio: "16:9", hook: { present: true, fontId: "anton", style: "boxed" } };
    const { client, create } = fakeClient({ skill: "Short clips.", suggested_name: "", look });
    const r = await buildFormatSkill({ family: "clip", kindLabel: "X video", answers: [], images: img, fromExamples: true, client });
    expect(r.ok && r.look).toEqual(look);
    const tool = create.mock.calls[0][0].tools[0];
    expect(tool.input_schema.properties.look).toBeDefined();
  });

  it("doesn't ask for a look for carousels or question answers, and drops a garbled one", async () => {
    const { client, create } = fakeClient({ skill: "x", suggested_name: "", look: { aspectRatio: "square" } });
    const carousel = await buildFormatSkill({ family: "design", kindLabel: "X post", answers: [], images: img, fromExamples: true, client });
    expect(create.mock.calls[0][0].tools[0].input_schema.properties.look).toBeUndefined();
    expect(carousel.ok && carousel.look).toBeNull();
    const garbled = await buildFormatSkill({ family: "clip", kindLabel: "Reel", answers: [], images: img, fromExamples: true, client });
    expect(garbled.ok && garbled.look).toBeNull();
  });
});

describe("plainSkillText", () => {
  it("strips headings, bullets and bold the model slipped in", () => {
    expect(plainSkillText("## Captions\n- **No** hashtags.\n\n\n\nShort.")).toBe("Captions\nNo hashtags.\n\nShort.");
  });
});

describe("buildFormatSkill", () => {
  it("refuses with nothing to go on, without calling the model", async () => {
    const { client, create } = fakeClient({});
    const r = await buildFormatSkill({ family: "clip", kindLabel: "Reel", answers: [{ question: "q", answer: " " }], client });
    expect(r).toEqual({ ok: false, failure: { reason: "nothing-to-go-on" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns the plain Skill and a suggested name", async () => {
    const { client } = fakeClient({ skill: "# Hook\nAsk a question.", suggested_name: "Tech Stack Reveal" });
    const r = await buildFormatSkill({ family: "clip", kindLabel: "Reel", answers: [{ question: "q", answer: "a" }], client });
    expect(r).toEqual({ ok: true, skill: "Hook\nAsk a question.", suggestedName: "Tech Stack Reveal", look: null });
  });

  it("fails soft on an empty Skill", async () => {
    const { client } = fakeClient({ skill: "", suggested_name: "" });
    const r = await buildFormatSkill({ family: "design", kindLabel: "X post", answers: [{ question: "q", answer: "a" }], client });
    expect(r).toEqual({ ok: false, failure: { reason: "llm-empty" } });
  });
});
