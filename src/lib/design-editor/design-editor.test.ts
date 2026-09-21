import { describe, it, expect } from "vitest";
import { parseDesignDoc, pageVideo, resizeCanvas, DEFAULT_CROP, IG_SQUARE, PHOTO_PLACEHOLDER, type DesignCaptionsElement, type DesignTextElement } from "./doc";
import { layoutDesignText, coverGeometry, cropForOffset } from "./layout";
import { buildPlaybookTemplate } from "./playbook-template";
import { buildTechStackTemplate } from "./tech-stack-template";
import { buildStoryTemplate } from "./story-template";
import { buildTmzTemplate } from "./tmz-template";
import { buildAppsTemplate } from "./apps-template";
import { DESIGN_PRESETS } from "./templates";
import { applyDmKeyword, applyHighlights, applyPhotoPick, fillTemplate, listSlots, reflowStacks, type DesignFill, type DesignFillValue } from "./template-fill";
import { formatFollowers, layoutChannel, resolveChannel } from "./channel";
import { fontsUsed, pageToSatoriTree, videoPageLayers } from "./render-tree";
import { buildDesignCaptionCues, activeCue } from "./captions";
import { buildVideoPageFilterGraph, videoPageFrames } from "./design-ffmpeg";
import { buildCaptionsAss } from "./design-ass";

const noPhoto = { photo: null, source: null, channel: { name: "Starter Story", subscribers: "800K subscribers" } };
const withSource = { ...noPhoto, source: { bucket: null, key: "hubandspoke/uploads/x/source.mp4", title: "How This SaaS Hit $69K/Month" } };

/** A fill that answers every AI slot of a template with something. */
function fillFor(template: ReturnType<typeof buildPlaybookTemplate>, over: Partial<Record<string, string>> = {}): DesignFill {
  const values = listSlots(template).flatMap((slot): DesignFillValue[] => {
    if (slot.kind === "video") return [{ key: slot.key, startSec: 60 + slot.pageIndex * 100, endSec: 95 + slot.pageIndex * 100 }];
    const text = over[slot.name] ?? (slot.name.startsWith("Phase 4") || slot.name.startsWith("Phase 5") ? "" : slot.sample);
    return text ? [{ key: slot.key, text, highlights: slot.name === "Headline" ? [{ phrase: "stopped guessing", color: "red" as const }, { phrase: "$69K/month SaaS", color: "green" as const }] : [] }] : [];
  });
  return { caption: "caption", values };
}

describe("applyHighlights", () => {
  it("colours exact phrases, case-insensitively, and leaves the rest plain", () => {
    const spans = applyHighlights("I STOPPED GUESSING what customers wanted", [{ phrase: "stopped guessing", color: "red" }]);
    expect(spans).toEqual([{ text: "I " }, { text: "STOPPED GUESSING", color: "#FF3B3B" }, { text: " what customers wanted" }]);
  });
  it("grows a phrase to whole words so closing punctuation keeps its colour", () => {
    expect(applyHighlights("Growing up, he was obese. The gym", [{ phrase: "he was obese", color: "red" }])).toEqual([{ text: "Growing up, " }, { text: "he was obese.", color: "#FF3B3B" }, { text: " The gym" }]);
  });
  it("ignores phrases that aren't in the text and overlapping ones", () => {
    const spans = applyHighlights("a b c", [{ phrase: "zzz", color: "red" }, { phrase: "a b", color: "green" }, { phrase: "b c", color: "red" }]);
    expect(spans).toEqual([{ text: "a b", color: "#22E07A" }, { text: " c" }]);
  });
});

describe("presets are valid templates with the expected slots", () => {
  it("playbook: photo slot, 2 AI text slots on the cover, a stacked Notes page, one video page, a DM CTA", () => {
    const t = buildPlaybookTemplate();
    expect(parseDesignDoc(JSON.parse(JSON.stringify(t))).ok).toBe(true);
    expect(t.pages).toHaveLength(4);
    expect(t.pages[0].elements.find((e) => e.name === "Photo")).toMatchObject({ slot: { kind: "photo" }, src: PHOTO_PLACEHOLDER });
    const slots = listSlots(t);
    expect(slots.filter((s) => s.pageIndex === 0).map((s) => s.name)).toEqual(["Headline", "Footer"]);
    expect(slots.find((s) => s.name === "Headline")?.highlightColors).toEqual(["green"]);
    expect(slots.filter((s) => s.kind === "video")).toHaveLength(1);
    expect(t.pages[1].elements.filter((e) => e.stack === "notes").length).toBeGreaterThan(8);
    expect(t.pages[2].elements.find((e) => e.name === "Video title")?.slot).toEqual({ kind: "videoTitle", hint: "" });
    expect(t.pages[3].elements.find((e) => e.name === "CTA")?.slot?.kind).toBe("dmKeyword");
  });
  it("story: cover, 9 beats with their own frame slots (5–9 optional), a static closer; tmz is one 4:5 page; apps has 5 square app pages", () => {
    const story = buildStoryTemplate();
    expect(story.pages).toHaveLength(11);
    expect(story.pages.slice(1, 10).every((p) => p.elements.some((e) => e.slot?.kind === "frame"))).toBe(true);
    expect(listSlots(story).filter((s) => s.hint.includes("Leave EMPTY"))).toHaveLength(5);
    expect(listSlots(story).filter((s) => s.pageIndex === 10)).toHaveLength(0);
    const tmz = buildTmzTemplate();
    expect(tmz.canvas).toEqual({ width: 1080, height: 1350 });
    expect(listSlots(tmz).map((s) => s.name)).toEqual(["Headline"]);
    const apps = buildAppsTemplate();
    expect(apps.canvas.height).toBe(1080);
    expect(apps.pages).toHaveLength(6);
    expect(listSlots(apps).filter((s) => s.pageIndex === 1).map((s) => s.name)).toEqual(["App name", "Result", "Bullets"]);
  });
  it("resizeCanvas stretches every box by the canvas's growth and leaves text sizes alone", () => {
    const doc = resizeCanvas(buildTmzTemplate(), { width: 1080, height: 1080 });
    expect(doc.canvas).toEqual({ width: 1080, height: 1080 });
    const photo = doc.pages[0].elements[0];
    expect(photo).toMatchObject({ y: 0, h: 592, w: 1080 }); // 740 × 1080/1350
    const headline = doc.pages[0].elements[1] as DesignTextElement;
    expect(headline.y).toBe(Math.round(764 * (1080 / 1350)));
    expect(headline.style.sizePx).toBe(92);
    expect(resizeCanvas(doc, { width: 1080, height: 1080 })).toBe(doc);
  });
  it("tech stack: cover band + stack list + one clip + CTA with the channel row", () => {
    const t = buildTechStackTemplate();
    expect(parseDesignDoc(JSON.parse(JSON.stringify(t))).ok).toBe(true);
    expect(t.pages.map((p) => p.elements.some((e) => e.type === "video"))).toEqual([false, false, true, false]);
    expect(listSlots(t).map((s) => s.name)).toEqual(["Headline", "Sub line", "Intro", "Stack", "Total", "Clip", "Pill label", "Question"]);
    // The CTA is a DM-keyword slot (ManyChat), not AI; the channel row is one live element.
    expect(t.pages[3].elements.find((e) => e.name === "CTA")?.slot?.kind).toBe("dmKeyword");
    expect(t.pages[3].elements.filter((e) => e.type === "channel")).toHaveLength(1);
  });
  it("every preset builds and parses", () => {
    for (const id of Object.keys(DESIGN_PRESETS) as Array<keyof typeof DESIGN_PRESETS>) {
      expect(parseDesignDoc(JSON.parse(JSON.stringify(DESIGN_PRESETS[id].build()))).ok).toBe(true);
    }
  });
});

describe("fillTemplate", () => {
  it("substitutes AI text with highlights, fills system slots from the item, gives everything fresh ids", () => {
    const t = buildPlaybookTemplate();
    const doc = fillTemplate(t, fillFor(t, { Headline: "I stopped guessing and built a $69K/month SaaS" }), { ...withSource, photo: { kind: "url", url: "https://x/founder.jpg" } });
    expect(parseDesignDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    const cover = doc.pages[0];
    expect(cover.elements.find((e) => e.name === "Photo")).toMatchObject({ src: { kind: "url", url: "https://x/founder.jpg" } });
    const headline = cover.elements.find((e) => e.name === "Headline") as DesignTextElement;
    expect(headline.spans.some((s) => s.color === "#FF3B3B")).toBe(true);
    const v = pageVideo(doc.pages[2])!;
    expect(v).toMatchObject({ src: { key: withSource.source.key }, startSec: 260, endSec: 295 });
    expect((doc.pages[2].elements.find((e) => e.name === "Video title") as DesignTextElement).spans[0].text).toBe(withSource.source.title);
    expect(doc.pages[2].elements.find((e) => e.type === "channel")).toMatchObject({ platform: "youtube", accountId: null });
    const ids = doc.pages.flatMap((p) => [p.id, ...p.elements.map((e) => e.id)]);
    const tIds = new Set(t.pages.flatMap((p) => [p.id, ...p.elements.map((e) => e.id)]));
    expect(ids.some((id) => tIds.has(id))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("drops empty AI slots and reflows the stack; drops video pages without a source", () => {
    const t = buildPlaybookTemplate();
    const doc = fillTemplate(t, fillFor(t), noPhoto);
    expect(doc.pages).toHaveLength(3); // no source → no video page; the CTA page stays
    const notes = doc.pages[1];
    expect(notes.elements.some((e) => e.name.startsWith("Phase 4"))).toBe(false);
    const stack = notes.elements.filter((e) => e.stack === "notes");
    for (let i = 1; i < stack.length; i++) expect(stack[i].y).toBeGreaterThanOrEqual(stack[i - 1].y + stack[i - 1].h);
    expect(Math.max(...notes.elements.map((e) => e.y + e.h))).toBeLessThanOrEqual(IG_SQUARE.height);
    // The photo slot keeps its placeholder until the frames arrive.
    expect(doc.pages[0].elements.find((e) => e.name === "Photo")).toMatchObject({ src: PHOTO_PLACEHOLDER });
  });

  it("a short stack grows to fill the page (up to 1.5×), keeping order and staying on the page", () => {
    const t = buildTechStackTemplate();
    const notes = fillTemplate(t, fillFor(t), noPhoto).pages[1];
    const stack = notes.elements.filter((e) => e.stack === "notes") as DesignTextElement[];
    const templateStack = t.pages[1].elements.filter((e) => e.stack === "notes") as DesignTextElement[];
    expect(stack[0].style.sizePx).toBeGreaterThanOrEqual(Math.round(templateStack[0].style.sizePx * 1.4));
    for (let i = 1; i < stack.length; i++) expect(stack[i].y).toBeGreaterThanOrEqual(stack[i - 1].y + stack[i - 1].h);
    expect(Math.max(...notes.elements.map((e) => e.y + e.h))).toBeLessThanOrEqual(IG_SQUARE.height);
  });

  it("a long playbook shrinks the stack until it fits", () => {
    const t = buildPlaybookTemplate();
    const long = Object.fromEntries(
      listSlots(t).filter((s) => s.name.match(/^Phase \d (heading|body)$/)).map((s) => [s.name, s.name.endsWith("heading") ? `${s.name}: Something quite long as a heading` : "A dense, specific paragraph of advice that keeps going with tools and numbers. ".repeat(6)]),
    );
    const notes = fillTemplate(t, fillFor(t, long), noPhoto).pages[1];
    expect(Math.max(...notes.elements.map((e) => e.y + e.h))).toBeLessThanOrEqual(IG_SQUARE.height);
    const bodies = notes.elements.filter((e) => e.name.endsWith("body")) as DesignTextElement[];
    expect(bodies).toHaveLength(5);
    expect(bodies[0].style.sizePx).toBeLessThan(29);
  });

  it("optional pages: a page whose AI text all came back empty is dropped; frame slots take distinct stills in order", () => {
    const t = buildStoryTemplate();
    const values = listSlots(t).filter((s) => s.pageIndex <= 6).map((s) => ({ key: s.key, text: `Beat ${s.pageIndex}` }));
    const frames = [1, 2, 3].map((n) => ({ kind: "url" as const, url: `https://x/f${n}.jpg` }));
    const doc = fillTemplate(t, { caption: "c", values }, { ...noPhoto, frames });
    // cover + 6 beats + closer (beats 7–9 empty → gone; the closer has no AI text → kept)
    expect(doc.pages).toHaveLength(8);
    const stills = doc.pages.slice(1).map((p) => (p.elements.find((e) => e.type === "image" && e.slot?.kind === "frame") as { src: { url?: string } }).src.url);
    expect(stills).toEqual(["https://x/f1.jpg", "https://x/f2.jpg", "https://x/f3.jpg", "https://x/f1.jpg", "https://x/f2.jpg", "https://x/f3.jpg", "https://x/f1.jpg"]);
    // Without frames the slots keep the placeholder and applyPhotoPick fills them later, distinctly.
    const bare = fillTemplate(t, { caption: "c", values }, noPhoto);
    const later = applyPhotoPick(bare, null, frames.slice(0, 2))!;
    expect(later.elementIds).toHaveLength(7);
    expect(Object.values(later.sources).map((s) => (s as { url: string }).url).slice(0, 3)).toEqual(["https://x/f1.jpg", "https://x/f2.jpg", "https://x/f1.jpg"]);
  });

  it("applyPhotoPick fills placeholder photo slots only", () => {
    const t = buildTechStackTemplate();
    const doc = fillTemplate(t, fillFor(t), withSource);
    const picked = applyPhotoPick(doc, { kind: "url", url: "https://x/y.jpg" })!;
    expect(picked.elementIds).toHaveLength(1);
    expect(applyPhotoPick(picked.doc, { kind: "url", url: "https://x/z.jpg" })).toBeNull();
  });

  it("DM keyword: the CTA keeps its wording, the token becomes the post's keyword, and can be re-substituted later", () => {
    const t = buildTechStackTemplate();
    const withKw = fillTemplate(t, fillFor(t), { ...withSource, dmKeyword: "bootstrap" });
    const cta = withKw.pages[3].elements.find((e) => e.name === "CTA") as DesignTextElement;
    expect(cta.spans[0].text).toBe('comment "BOOTSTRAP" and i\'ll DM you the full video.');
    expect(cta.slot).toEqual({ kind: "dmKeyword", hint: 'comment "{{keyword}}" and i\'ll DM you the full video.' });
    const none = fillTemplate(t, fillFor(t), withSource);
    expect((none.pages[3].elements.find((e) => e.name === "CTA") as DesignTextElement).spans[0].text).toContain("{{keyword}}");
    const swapped = applyDmKeyword(withKw, "dailywin");
    expect((swapped.pages[3].elements.find((e) => e.name === "CTA") as DesignTextElement).spans[0].text).toContain('"DAILYWIN"');
  });

  it("reflowStacks leaves pages without stacks alone", () => {
    const page = buildTechStackTemplate().pages[0];
    expect(reflowStacks(page)).toBe(page);
  });
});

describe("layoutDesignText", () => {
  const el: DesignTextElement = {
    id: "t", name: "t", type: "text", x: 100, y: 100, w: 800, h: 300, opacity: 1, locked: false,
    spans: [{ text: "Hello " }, { text: "world", color: "#22E07A" }, { text: " again" }],
    style: { fontId: "anton", sizePx: 80, lineHeight: 1.2, letterSpacing: 0, color: "#FFFFFF", align: "center", valign: "bottom", uppercase: true, shadow: null, autoFit: false, minSizePx: 20 },
    slot: null, stack: null,
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
    const doc = buildPlaybookTemplate();
    const page = doc.pages[0];
    const tree = pageToSatoriTree(page, doc.canvas, {});
    const children = (tree.props as { children: Array<{ props: { style: Record<string, unknown> } }> }).children;
    expect(children.length).toBeGreaterThan(3);
    expect(children.every((c) => c.props.style.position === "absolute")).toBe(true);
    expect(fontsUsed(page).map((f) => f.id)).toEqual(expect.arrayContaining(["anton", "inter-regular"]));
  });
});

const words = (spec: string) =>
  spec.split(" ").map((text, i) => ({ index: i, text, startSec: 100 + i * 0.5, endSec: 100 + i * 0.5 + 0.4 }));

describe("video slides", () => {
  const filled = () => {
    const t = buildPlaybookTemplate();
    return fillTemplate(t, fillFor(t), withSource);
  };
  it("a filled playbook has its clip page with a clip, captions and the pill, then the CTA", () => {
    const t = buildPlaybookTemplate();
    const doc = fillTemplate(t, fillFor(t), withSource);
    expect(parseDesignDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    expect(doc.pages).toHaveLength(4);
    const v = pageVideo(doc.pages[2])!;
    expect(v).toMatchObject({ startSec: 260, endSec: 295, src: { key: withSource.source.key } });
    expect(doc.pages[2].elements.map((e) => e.type)).toContain("captions");
    expect(doc.pages[2].elements.find((e) => e.name === "Pill label")).toBeTruthy();
    expect(doc.pages[2].elements.find((e) => e.name === "Video title")).toMatchObject({ spans: [{ text: withSource.source.title }] });
    expect(doc.pages[3].elements.find((e) => e.name === "CTA")).toBeTruthy();
  });

  it("a page holds at most one clip", () => {
    const doc = filled();
    const v = pageVideo(doc.pages[2])!;
    const twice = { ...doc, pages: [{ ...doc.pages[2], elements: [...doc.pages[2].elements, { ...v, id: "dup" }] }] };
    expect(parseDesignDoc(JSON.parse(JSON.stringify(twice))).ok).toBe(false);
  });

  it("splits a video page into what's under and over the footage", () => {
    const page = filled().pages[2];
    const { under, over } = videoPageLayers(page);
    expect(under.elements.some((e) => e.type === "video")).toBe(false);
    expect(over.elements.some((e) => e.type === "video")).toBe(false);
    expect(over.elements.map((e) => e.name)).toContain("Pill");
    expect(under.elements.length + over.elements.length).toBe(page.elements.length - 1);
  });

  it("old docs without crop still parse (crop defaults) and the filter graph places the clip from the same geometry as the stage", () => {
    const doc = filled();
    const raw = JSON.parse(JSON.stringify(doc));
    for (const el of raw.pages[0].elements) { delete el.crop; delete el.slot; delete el.stack; }
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
    const el: DesignCaptionsElement = { id: "c", name: "Captions", type: "captions", x: 60, y: 60, w: 960, h: 130, opacity: 1, locked: false, maxWordsPerCue: 12, style: { fontId: "inter-regular", sizePx: 32, lineHeight: 1.25, letterSpacing: 0, color: "#5C5C5C", align: "center", valign: "middle", uppercase: false, shadow: null, autoFit: true, minSizePx: 20 }, slot: null, stack: null };
    const ass = buildCaptionsAss(el, cues, IG_SQUARE);
    expect(ass).toContain("Style: Cap0,Inter");
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
    expect(ass).toContain("gamma delta epsilon");
  });
});

describe("channel element", () => {
  const el = { id: "ch", name: "Channel", type: "channel" as const, x: 30, y: 900, w: 620, h: 68, opacity: 1, locked: false, slot: null, stack: null, accountId: null, platform: "youtube" as const, showFollowers: true, theme: "light" as const };
  const yt = { accountId: "a1", platform: "youtube", name: "Starter Story", handle: "starterstory", avatarUrl: null, followerCount: 875_000, verified: true };
  const ig = { accountId: "a2", platform: "instagram", name: "Starter Story", handle: "starter_story", avatarUrl: null, followerCount: 120_000, verified: true };
  it("resolves by account id, else the brand's account on the platform", () => {
    expect(resolveChannel(el, [ig, yt])?.accountId).toBe("a1");
    expect(resolveChannel({ ...el, accountId: "a2" }, [ig, yt])?.accountId).toBe("a2");
    expect(resolveChannel({ ...el, platform: "tiktok" }, [ig, yt])).toBeNull();
  });
  it("lays out avatar + name ✓ + followers from the box height", () => {
    const l = layoutChannel(el, yt);
    expect(l.avatar).toEqual({ x: 30, y: 900, d: 68 });
    expect(l.name.spans[0].text).toBe("Starter Story ✓");
    expect(l.followers?.spans[0].text).toBe("875K subscribers");
    expect(l.name.x).toBeGreaterThan(30 + 68);
    expect(formatFollowers(1_250_000, "instagram")).toBe("1.3M followers");
    expect(layoutChannel({ ...el, showFollowers: false }, yt).followers).toBeNull();
  });
});
