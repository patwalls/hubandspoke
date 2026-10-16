import { describe, expect, it } from "vitest";
import { buildTechStackTemplate } from "@/lib/design-editor/tech-stack-template";
import { listSlots } from "@/lib/design-editor/template-fill";
import { buildFillPrompt, coerceFill, describeExemplars, describeSlots, exemplarContent, parseTimestamp, stripFormatPrefix } from "./fill-brief";
import { snapClipToWords } from "./session";

const slots = listSlots(buildTechStackTemplate());
const key = (name: string) => slots.find((s) => s.name === name)!.key;

describe("coerceFill", () => {
  it("keeps known slots only, trims text, drops disallowed highlight colours, clamps clips to 12–75s, parses MM:SS", () => {
    const fill = coerceFill(
      {
        caption: "  cap ",
        values: [
          { key: key("Headline"), text: " This guy makes $40K/mo. ", highlights: [{ phrase: "$40K", color: "green" }] },
          { key: key("Clip"), startSec: "10:00", endSec: "10:05" },
          { key: "nope", text: "x" },
          { key: key("Total"), text: "" },
        ],
      },
      slots,
    )!;
    expect(fill.caption).toBe("cap");
    expect(fill.values).toEqual([
      { key: key("Headline"), text: "This guy makes $40K/mo.", highlights: [] }, // the sample has no colours → none allowed
      { key: key("Clip"), startSec: 600, endSec: 612 },
    ]);
  });
  it("carries the model's notes for the editor, trimmed, and drops empty ones", () => {
    const value = { key: key("Headline"), text: "x" };
    expect(coerceFill({ caption: "c", notes: "  Looked up https://x.com/maks6361 — no app names there.  ", values: [value] }, slots)!.notes).toBe("Looked up https://x.com/maks6361 — no app names there.");
    expect("notes" in coerceFill({ caption: "c", notes: "   ", values: [value] }, slots)!).toBe(false);
    expect("notes" in coerceFill({ caption: "c", values: [value] }, slots)!).toBe(false);
  });
  it("returns null when nothing usable came back", () => {
    expect(coerceFill({ values: [] }, slots)).toBeNull();
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });
  it("describes slots for the prompt with their room and hints", () => {
    const text = describeSlots(slots);
    expect(text).toContain(`key "${key("Stack")}" — TEXT (slide 2)`);
    expect(text).toContain("maxChars:");
    expect(text).toContain(`key "${key("Clip")}" — CLIP (slide 3)`);
  });
});

describe("exemplars — what a later post learns the format from", () => {
  it("reads a carousel draft's slides in order, a text post's body, and the caption", () => {
    expect(exemplarContent({ caption: "cap", slides: [{ text: "second", order: 2 }, { text: " first ", order: 1 }, { text: "", order: 3 }] })).toEqual({ caption: "cap", slides: ["first", "second"], body: null });
    expect(exemplarContent({ body: "He runs 3 boring database websites…", cta: "x" })).toEqual({ caption: null, slides: [], body: "He runs 3 boring database websites…" });
    expect(exemplarContent({ post: "tweet text" }).body).toBe("tweet text");
    expect(exemplarContent(null)).toEqual({ caption: null, slides: [], body: null });
  });
  it("strips a hook synced as '<format>: <headline>' down to the headline", () => {
    expect(stripFormatPrefix("What My Apps Are & What They Do: I make $32K/month from 3 boring websites", "What My Apps Are & What They Do")).toBe("I make $32K/month from 3 boring websites");
    expect(stripFormatPrefix("I BUILT 5 APPS", "What My Apps Are & What They Do")).toBe("I BUILT 5 APPS");
  });
  it("shows the past posts slide by slide, so the model sees one app per slide", () => {
    const text = describeExemplars([{ hook: "I BUILT 5 APPS", views: 400588, caption: "cap", body: null, slides: ["He built 5 SaaS apps doing $200K MRR", "Curator, Thrill, Juno, Fluke, and soon Smile."] }]);
    expect(text).toContain("1. HEADLINE: I BUILT 5 APPS (400,588 views)");
    expect(text).toContain("   SLIDE 1: He built 5 SaaS apps doing $200K MRR");
    expect(text).toContain("   SLIDE 2: Curator, Thrill, Juno, Fluke, and soon Smile.");
    expect(text).toContain("   CAPTION: cap");
  });
  it("puts the video description (the founder's links) in the prompt, before the transcript", () => {
    const blocks = buildFillPrompt({ title: "Max: 28 apps", formatName: "F", description: "Follow Max: https://x.com/maks6361", skill: null, exemplars: [], transcript: "t", slots, instruction: null });
    const texts = blocks.map((b) => b.text);
    const desc = texts.findIndex((t) => t.startsWith("## VIDEO DESCRIPTION"));
    expect(desc).toBeGreaterThan(0);
    expect(texts[desc]).toContain("https://x.com/maks6361");
    expect(desc).toBeLessThan(texts.findIndex((t) => t.startsWith("## TRANSCRIPT")));
    expect(buildFillPrompt({ title: null, formatName: "F", description: "  ", skill: null, exemplars: [], transcript: "t", slots, instruction: null }).some((b) => b.text.startsWith("## VIDEO DESCRIPTION"))).toBe(false);
  });
});

describe("snapClipToWords", () => {
  const words = ["one", "two", "three", "four", "five"].map((text, i) => ({ index: i, text, startSec: 10 + i * 2, endSec: 10 + i * 2 + 1.5 }));
  it("moves the edges onto nearby word boundaries with a little air", () => {
    expect(snapClipToWords({ startSec: 11.2, endSec: 17.2, label: "l" }, words)).toEqual({ startSec: 11.85, endSec: 17.75, label: "l" });
  });
  it("leaves a clip alone when no word is near its edges", () => {
    expect(snapClipToWords({ startSec: 100, endSec: 130, label: "l" }, words)).toEqual({ startSec: 100, endSec: 130, label: "l" });
  });
});
