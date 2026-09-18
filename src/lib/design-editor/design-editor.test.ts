import { describe, it, expect } from "vitest";
import { parseDesignDoc, IG_SQUARE, type DesignTextElement } from "./doc";
import { layoutDesignText } from "./layout";
import { applyHighlights, buildNotesPage, buildPlaybookDoc, ensureCoverPhoto, type PlaybookBrief } from "./playbook-template";
import { fontsUsed, pageToSatoriTree, videoPageLayers } from "./render-tree";
import { coverGeometry, cropForOffset } from "./layout";
import { buildDesignCaptionCues, activeCue } from "./captions";
import { buildVideoPageFilterGraph, videoPageFrames } from "./design-ffmpeg";
import { buildCaptionsAss } from "./design-ass";
import { pageVideo, DEFAULT_CROP, type DesignCaptionsElement, type DesignVideoElement } from "./doc";

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
  clips: [
    { startSec: 60, endSec: 95, label: "Phase 1" },
    { startSec: 400, endSec: 440, label: "Phase 3" },
  ],
  pillLabel: "CUSTOMER CALLS PLAYBOOK",
};
const noPhoto = { photo: null, source: null, channel: { name: "Starter Story", subscribers: "800K subscribers" } };
const withSource = { ...noPhoto, source: { bucket: null, key: "hubandspoke/uploads/x/source.mp4", title: "How This SaaS Hit $69K/Month" } };

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
    const doc = buildPlaybookDoc(brief, { ...noPhoto, photo: { kind: "url", url: "https://example.com/a.jpg" } });
    expect(parseDesignDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(doc.pages).toHaveLength(2);
    const names = doc.pages[0].elements.map((e) => e.name);
    expect(names).toEqual(["Photo", "Shade", "Logo", "Stat", "Stat unit", "Headline", "Footer"]);
    const headline = doc.pages[0].elements.find((e) => e.name === "Headline") as DesignTextElement;
    expect(headline.spans.some((s) => s.color === "#FF3B3B")).toBe(true);
    expect(headline.spans.some((s) => s.color === "#22E07A")).toBe(true);
  });

  it("omits the photo when there is none, and everything still lays out on-canvas", () => {
    const doc = buildPlaybookDoc(brief, noPhoto);
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
    const doc = buildPlaybookDoc(brief, noPhoto);
    const page = doc.pages[0];
    const tree = pageToSatoriTree(page, doc.canvas, {});
    const children = (tree.props as { children: Array<{ props: { style: Record<string, unknown> } }> }).children;
    expect(children.length).toBeGreaterThan(5);
    expect(children.every((c) => c.props.style.position === "absolute")).toBe(true);
    expect(fontsUsed(page).map((f) => f.id)).toEqual(expect.arrayContaining(["anton", "montserrat-medium", "inter-regular"]));
  });
});

const words = (spec: string) =>
  spec.split(" ").map((text, i) => ({ index: i, text, startSec: 100 + i * 0.5, endSec: 100 + i * 0.5 + 0.4 }));

describe("video slides", () => {
  it("the template adds one video page per clip, each with a clip, captions and the pill", () => {
    const doc = buildPlaybookDoc(brief, withSource);
    expect(parseDesignDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(doc.pages).toHaveLength(4);
    const v = pageVideo(doc.pages[2])!;
    expect(v).toMatchObject({ startSec: 60, endSec: 95, src: { key: withSource.source.key } });
    expect(doc.pages[2].elements.map((e) => e.type)).toContain("captions");
    expect(doc.pages[2].elements.find((e) => e.name === "Pill label")).toBeTruthy();
    expect(doc.pages[3].elements.find((e) => e.name === "Video title")).toMatchObject({ spans: [{ text: withSource.source.title }] });
  });

  it("without a source there are no video pages; a page holds at most one clip", () => {
    expect(buildPlaybookDoc(brief, noPhoto).pages).toHaveLength(2);
    const doc = buildPlaybookDoc(brief, withSource);
    const v = pageVideo(doc.pages[2])!;
    const twice = { ...doc, pages: [{ ...doc.pages[2], elements: [...doc.pages[2].elements, { ...v, id: "dup" }] }] };
    expect(parseDesignDoc(JSON.parse(JSON.stringify(twice))).ok).toBe(false);
  });

  it("splits a video page into what's under and over the footage", () => {
    const page = buildPlaybookDoc(brief, withSource).pages[2];
    const { under, over } = videoPageLayers(page);
    expect(under.elements.some((e) => e.type === "video")).toBe(false);
    expect(over.elements.some((e) => e.type === "video")).toBe(false);
    expect(over.elements.map((e) => e.name)).toContain("Pill");
    expect(under.elements.length + over.elements.length).toBe(page.elements.length - 1);
  });

  it("old docs without crop still parse (crop defaults) and the filter graph places the clip from the same geometry as the stage", () => {
    const doc = buildPlaybookDoc(brief, withSource);
    const raw = JSON.parse(JSON.stringify(doc));
    for (const el of raw.pages[0].elements) delete el.crop;
    const parsed = parseDesignDoc(raw);
    expect(parsed.ok && parsed.doc.pages[0].elements.find((e) => e.type === "image")).toMatchObject({ crop: DEFAULT_CROP });

    const v = pageVideo(doc.pages[2])!;
    const g = coverGeometry({ width: 1920, height: 1080 }, { w: v.w, h: v.h }, v.crop);
    const graph = buildVideoPageFilterGraph({ video: v, sourceSize: { width: 1920, height: 1080 }, canvas: doc.canvas, assPath: "/tmp/c.ass", fontsDir: "/f" });
    expect(graph).toContain(`scale=${Math.round(g.width / 2) * 2}:${Math.round(g.height / 2) * 2}`);
    expect(graph).toContain(`crop=${v.w}:${v.h}:${Math.round(-g.left)}:${Math.round(-g.top)}`);
    expect(graph).toContain(`overlay=x=${v.x}:y=${v.y}`);
    expect(graph).toContain("alphamerge"); // rounded corners
    expect(graph).toContain(`trim=end_frame=${videoPageFrames(v)}`);
    expect(graph).toContain("ass=filename='/tmp/c.ass'");
    expect(graph).toContain(`atrim=duration=${(videoPageFrames(v) / 30).toFixed(3)}`);
  });
});

describe("coverGeometry", () => {
  const box = { w: 1080, h: 1080 };
  it("plain cover centres the picture; zoom scales about the focal point; pan never shows a gap", () => {
    const wide = { width: 1920, height: 1080 };
    const g = coverGeometry(wide, box, DEFAULT_CROP);
    expect(g.height).toBe(1080);
    expect(g.width).toBe(1920);
    expect(g.left).toBeCloseTo(-420);
    const left = coverGeometry(wide, box, { x: 0, y: 0.5, zoom: 1 });
    expect(left.left).toBe(0);
    const right = coverGeometry(wide, box, { x: 1, y: 0.5, zoom: 1 });
    expect(right.left).toBeCloseTo(box.w - 1920);
    const zoomed = coverGeometry(wide, box, { x: 0.5, y: 0.5, zoom: 2 });
    expect(zoomed.width).toBe(3840);
    expect(zoomed.left).toBeCloseTo(540 - 1920);
  });
  it("cropForOffset inverts the pan so dragging by dx moves the picture by dx", () => {
    const wide = { width: 1920, height: 1080 };
    const start = coverGeometry(wide, box, DEFAULT_CROP);
    const crop = cropForOffset(wide, box, DEFAULT_CROP, { left: start.left + 100, top: start.top });
    expect(coverGeometry(wide, box, crop).left).toBeCloseTo(start.left + 100);
  });
});

describe("captions", () => {
  it("cuts cues at sentence ends, long pauses and the word cap, in clip time", () => {
    const ws = words("we did two thousand calls. then we built the thing and it worked and people paid us money for it every single month");
    ws[8].startSec += 3; // long pause before "and" (index 8)
    for (let i = 8; i < ws.length; i++) { ws[i].startSec += 3; ws[i].endSec += 3; }
    const cues = buildDesignCaptionCues(ws, { startSec: 100, endSec: 130 }, 8);
    expect(cues[0].text).toBe("we did two thousand calls.");
    expect(cues[0].startSec).toBe(0);
    expect(cues[1].text).toBe("then we built");
    expect(cues[1].endSec).toBeCloseTo(ws[7].endSec - 100, 5); // pause → ends at the last word
    expect(cues[2].text.split(" ").length).toBeLessThanOrEqual(8);
    expect(cues.every((c) => c.endSec > c.startSec)).toBe(true);
    expect(activeCue(cues, 0.1)?.text).toBe(cues[0].text);
  });

  it("only takes words inside the clip and writes one ASS event per laid-out line", () => {
    const ws = words("alpha beta gamma delta epsilon zeta eta theta");
    const cues = buildDesignCaptionCues(ws, { startSec: 101, endSec: 102.5 }, 12);
    expect(cues.map((c) => c.text).join(" ")).toBe("gamma delta epsilon");
    const el: DesignCaptionsElement = { id: "c", name: "Captions", type: "captions", x: 60, y: 60, w: 960, h: 130, opacity: 1, locked: false, maxWordsPerCue: 12, style: { fontId: "inter-regular", sizePx: 32, lineHeight: 1.25, color: "#5C5C5C", align: "center", valign: "middle", uppercase: false, shadow: null, autoFit: true, minSizePx: 20 } };
    const ass = buildCaptionsAss(el, cues, IG_SQUARE);
    expect(ass).toContain("Style: Cap0,Inter");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
    expect(ass).toContain("gamma delta epsilon");
  });
});

describe("ensureCoverPhoto", () => {
  it("adds a full-bleed photo under everything only when the cover has none", () => {
    const doc = buildPlaybookDoc(brief, noPhoto);
    const patched = ensureCoverPhoto(doc, { kind: "url", url: "https://x/y.jpg" })!;
    expect(patched.pages[0].elements[0]).toMatchObject({ name: "Photo", x: 0, y: 0, w: 1080, h: 1080 });
    expect(ensureCoverPhoto(patched, { kind: "url", url: "https://x/z.jpg" })).toBeNull();
  });
});

void ((): DesignVideoElement | null => null);
