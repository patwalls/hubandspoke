import { describe, it, expect } from "vitest";
import { parseDesignDoc, IG_SQUARE, type DesignTextElement } from "./doc";
import { layoutDesignText } from "./layout";
import { applyHighlights, buildNotesPage, buildPlaybookDoc, type PlaybookBrief } from "./playbook-template";
import { fontsUsed, pageToSatoriTree } from "./render-tree";

const brief: PlaybookBrief = {
  stat: "$720K",
  statUnit: "/year",
  headline: "I stopped guessing what customers wanted. 2,000 calls later I had a $69K/month SaaS",
  highlights: [{ phrase: "stopped guessing", color: "red" }, { phrase: "$69K/month SaaS", color: "green" }],
  footer: "See his 3-Phase playbook→",
  notesTitle: "The 3-Phase Customer Call Playbook",
  phases: [
    { heading: "Phase 1: Discovery", body: "Reach out to your network and get on calls. ".repeat(3) },
    { heading: "Phase 2: Usability", body: "Watch users navigate without helping. ".repeat(3) },
    { heading: "Phase 3: Power users", body: "Track usage with PostHog and call the top users. ".repeat(3) },
  ],
  caption: "caption",
};

describe("applyHighlights", () => {
  it("colours exact phrases, case-insensitively, and leaves the rest plain", () => {
    const spans = applyHighlights("I STOPPED GUESSING what customers wanted", [{ phrase: "stopped guessing", color: "red" }]);
    expect(spans).toEqual([
      { text: "I " },
      { text: "STOPPED GUESSING", color: "#FF3B3B" },
      { text: " what customers wanted" },
    ]);
  });

  it("ignores phrases that aren't in the text and overlapping ones", () => {
    const spans = applyHighlights("a b c", [{ phrase: "zzz", color: "red" }, { phrase: "a b", color: "green" }, { phrase: "b c", color: "red" }]);
    expect(spans).toEqual([{ text: "a b", color: "#22E07A" }, { text: " c" }]);
  });
});

describe("buildPlaybookDoc", () => {
  it("produces a valid two-page doc with the expected slots", () => {
    const doc = buildPlaybookDoc(brief, { kind: "url", url: "https://example.com/a.jpg" });
    expect(parseDesignDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(doc.pages).toHaveLength(2);
    const names = doc.pages[0].elements.map((e) => e.name);
    expect(names).toEqual(["Photo", "Shade", "Logo", "Stat", "Stat unit", "Headline", "Footer"]);
    const headline = doc.pages[0].elements.find((e) => e.name === "Headline") as DesignTextElement;
    expect(headline.spans.some((s) => s.color === "#FF3B3B")).toBe(true);
    expect(headline.spans.some((s) => s.color === "#22E07A")).toBe(true);
  });

  it("omits the photo when there is none, and everything still lays out on-canvas", () => {
    const doc = buildPlaybookDoc(brief, null);
    expect(doc.pages[0].elements.map((e) => e.name)).not.toContain("Photo");
    for (const el of doc.pages[0].elements) {
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.y + el.h).toBeLessThanOrEqual(IG_SQUARE.height);
    }
  });

  it("shrinks a long playbook until the notes page fits", () => {
    const long: PlaybookBrief = {
      ...brief,
      phases: Array.from({ length: 5 }, (_, i) => ({
        heading: `Phase ${i + 1}: Something quite long as a heading`,
        body: "A dense, specific paragraph of advice that keeps going with tools and numbers. ".repeat(6),
      })),
    };
    const page = buildNotesPage(long);
    const bottom = Math.max(...page.elements.map((e) => e.y + e.h));
    expect(bottom).toBeLessThanOrEqual(IG_SQUARE.height);
    const bodies = page.elements.filter((e) => e.name.endsWith("body")) as DesignTextElement[];
    expect(bodies[0].style.sizePx).toBeLessThan(29); // scaled down from the base size
  });
});

describe("layoutDesignText", () => {
  const el: DesignTextElement = {
    id: "t", name: "t", type: "text", x: 100, y: 100, w: 800, h: 300, opacity: 1, locked: false,
    spans: [{ text: "Hello " }, { text: "world", color: "#22E07A" }, { text: " again" }],
    style: { fontId: "anton", sizePx: 80, lineHeight: 1.2, color: "#FFFFFF", align: "center", valign: "bottom", uppercase: true, shadow: null, autoFit: false, minSizePx: 20 },
  };

  it("carries span colours onto words, uppercases, and anchors to the box", () => {
    const layout = layoutDesignText(el);
    const words = layout.lines.flatMap((l) => l.words);
    expect(words.map((w) => [w.text, w.color])).toEqual([["HELLO", null], ["WORLD", "#22E07A"], ["AGAIN", null]]);
    expect(layout.lines[0].y + layout.linePitchPx).toBeCloseTo(el.y + el.h, 5); // bottom-aligned
    expect(layout.lines[0].x).toBeGreaterThan(el.x); // centered → inset from the left edge
  });

  it("autoFit shrinks the font until the text fits the box", () => {
    const tall = { ...el, w: 300, h: 120, spans: [{ text: "one two three four five six seven eight nine ten" }], style: { ...el.style, autoFit: true } };
    const layout = layoutDesignText(tall);
    expect(layout.overflows).toBe(false);
    expect(layout.fontSizePx).toBeLessThan(80);
  });
});

describe("render tree", () => {
  it("mirrors the layout as absolutely positioned single-line nodes", () => {
    const doc = buildPlaybookDoc(brief, null);
    const page = doc.pages[0];
    const tree = pageToSatoriTree(page, doc.canvas, {});
    const children = (tree.props as { children: Array<{ props: { style: Record<string, unknown> } }> }).children;
    expect(children.length).toBeGreaterThan(5);
    expect(children.every((c) => c.props.style.position === "absolute")).toBe(true);
    expect(fontsUsed(page).map((f) => f.id)).toEqual(expect.arrayContaining(["anton", "montserrat-medium", "inter-regular"]));
  });
});
