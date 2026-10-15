import { describe, it, expect } from "vitest";
import { createDefaultDoc, parseDoc, wordEditKey, type MediaAsset } from "./doc";
import { compileRenderPlan, sourceToOutput } from "./plan";
import { buildFilterGraph, buildRenderArgs } from "./ffmpeg-args";
import { deleteSection, includeRange, insertMediaScene, retimeSectionInDoc } from "./sections";
import { buildTranscriptView, selectionActions } from "./transcript-view";
import { clipCutFromDoc } from "./clip-cut";
import { rangeForWordRun, type EditorWord } from "./words";

// Source words at 0–3s — the same TIMES the uploaded intro's own footage has,
// which is exactly the confusion these tests guard against.
const words: EditorWord[] = ["hey", "so", "today", "we", "talk"].map((text, i) => ({
  index: i, text, startSec: i * 0.6, endSec: i * 0.6 + 0.5,
}));
const intro: MediaAsset = { id: "media-intro", key: "hubandspoke/uploads/item/x-intro.mov", name: "intro.mov", durationSec: 8, width: 1080, height: 1920 };

/** The source clip is 0–3s; the 8s intro is put in front of it. */
const withIntro = () => insertMediaScene(createDefaultDoc({ startSec: 0, endSec: 3, hook: "Hook" }), intro, 0);

describe("an uploaded clip as a scene", () => {
  it("plays first, whole, from its own file — then the source", () => {
    const plan = compileRenderPlan(withIntro(), words);
    expect(plan.inputs.map((i) => i.mediaId)).toEqual(["media-intro", null]);
    expect(plan.segments[0]).toMatchObject({ mediaId: "media-intro", outStartSec: 0, outEndSec: 8 });
    expect(plan.segments[1]).toMatchObject({ mediaId: null, outStartSec: 8 });
    expect(plan.durationSec).toBeCloseTo(11, 5);
  });

  it("gets no captions from the source words that share its times", () => {
    const cues = compileRenderPlan(withIntro(), words).captions!.cues;
    // Every caption is in the source part, after the intro.
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((c) => c.outStartSec >= 8)).toBe(true);
    // And clicking a source word lands in the source scene, not the intro.
    expect(sourceToOutput(compileRenderPlan(withIntro(), words), 0.7)).toBeCloseTo(8.7, 5);
  });

  it("isn't a part of the transcript", () => {
    const view = buildTranscriptView(withIntro(), words);
    const body = withIntro().sections[1].id;
    expect(view.words.every((w) => w.sectionId === body)).toBe(true);
    expect(view.tokens.filter((t) => t.kind === "marker")).toHaveLength(1);
  });

  it("adding words from the transcript never fuses into it", () => {
    const d = includeRange(withIntro(), { startSec: 3, endSec: 4 });
    expect(d.sections).toHaveLength(2);
    expect(d.sections[0].mediaId).toBe("media-intro");
    expect(d.sections[1]).toMatchObject({ startSec: 0, endSec: 4 });
  });

  it("trims inside its own file: 0 to its length, ignoring the source's scenes", () => {
    const d = withIntro();
    const id = d.sections[0].id;
    const trimmed = retimeSectionInDoc(d, id, { startSec: 1, endSec: 20 });
    expect(trimmed.sections[0]).toMatchObject({ startSec: 1, endSec: 8 });
  });

  it("the doc round-trips, and docs from before uploads still parse", () => {
    const parsed = parseDoc(JSON.parse(JSON.stringify(withIntro())));
    expect(parsed.ok && parsed.doc.media).toEqual([intro]);
    const old = JSON.parse(JSON.stringify(createDefaultDoc({ startSec: 0, endSec: 3, hook: "" })));
    delete old.media;
    const legacy = parseDoc(old);
    expect(legacy.ok && legacy.doc.media).toEqual([]);
  });

  it("a deleted clip's file is dropped from the doc on the next upload", () => {
    const d = deleteSection(withIntro(), "sec-media-intro");
    const next: MediaAsset = { ...intro, id: "media-two" };
    expect(insertMediaScene(d, next, 0).media.map((m) => m.id)).toEqual(["media-two"]);
  });

  it("the clip-created comment's range is the source span, not the intro's", () => {
    expect(clipCutFromDoc(withIntro(), words)).toMatchObject({ startSec: 0, endSec: 3 });
  });
});

describe("exporting an uploaded clip", () => {
  const plan = () => compileRenderPlan(withIntro(), words);

  it("opens the uploaded file for its scene and the source for the rest", () => {
    const argv = buildRenderArgs({ plan: plan(), input: "/w/source", media: { "media-intro": "/w/media-intro" }, filterScriptPath: "/w/g.txt", outputPath: "/w/o.mp4" });
    const inputs = argv.flatMap((a, i) => (a === "-i" ? [argv[i + 1]] : []));
    expect(inputs).toEqual(["/w/media-intro", "/w/source"]);
  });

  it("refuses to render when the uploaded file is missing", () => {
    expect(() => buildRenderArgs({ plan: plan(), input: "/w/source", filterScriptPath: "/g", outputPath: "/o" })).toThrow(/media-intro/);
  });

  it("places each file at its own size before joining them", () => {
    const graph = buildFilterGraph(plan(), {
      assPath: null,
      fontsDir: "/f",
      sourceSize: { width: 1920, height: 1080 },
      mediaSizes: { "media-intro": { width: 1080, height: 1920 } },
    });
    // The vertical intro fills the 9:16 canvas; the landscape source is letterboxed.
    expect(graph).toContain("[vr0]scale=1080:1920");
    expect(graph).toContain("[vr1]scale=1080:608");
    expect(graph).toMatch(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2/);
  });

  it("plays silence for a clip with no audio track", () => {
    const graph = buildFilterGraph(plan(), { assPath: null, fontsDir: "/f", sourceSize: { width: 1920, height: 1080 }, mediaSizes: { "media-intro": { width: 1080, height: 1920 } }, silentMedia: ["media-intro"] });
    // 8s at 30fps = 240 frames × 1600 samples.
    expect(graph).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=384000");
    expect(graph).not.toContain("[0:a]");
    expect(graph).toContain("[1:a]aresample");
  });
});

describe("a transcribed uploaded clip", () => {
  // Saj's intro says "welcome back everyone" at 0–1.8s of its own file.
  const spoken: MediaAsset = {
    ...intro,
    words: [
      { text: "Welcome", startSec: 0.2, endSec: 0.7 },
      { text: "back", startSec: 0.8, endSec: 1.1 },
      { text: "everyone.", startSec: 1.2, endSec: 1.8 },
    ],
  };
  const doc = () => insertMediaScene(createDefaultDoc({ startSec: 0, endSec: 3, hook: "Hook" }), spoken, 0);
  const introId = "sec-media-intro";

  it("shows its words first in the transcript, in its own scene", () => {
    const view = buildTranscriptView(doc(), words);
    const shown = view.displayOrder.map((p) => view.words[p]);
    expect(shown.slice(0, 3).map((w) => [w.text, w.sectionId])).toEqual([
      ["Welcome", introId],
      ["back", introId],
      ["everyone.", introId],
    ]);
    expect(shown[3].text).toBe("hey");
    expect(view.tokens.find((t) => t.kind === "marker")).toMatchObject({ sectionId: introId, index: 1 });
  });

  it("deleting a word cuts it from the intro's own file, not the source", () => {
    const d = doc();
    const view = buildTranscriptView(d, words);
    const back = view.words.find((w) => w.text === "back")!;
    const acts = selectionActions(view, d, back.pos, back.pos);
    // Runs to "everyone." — the short pause after a cut word goes with it.
    expect(acts.ranges).toEqual([{ sectionId: introId, range: { startSec: 0.8, endSec: 1.2 } }]);
    expect(acts.include).toEqual([]);
  });

  it("is captioned from its own words — and the source's after it", () => {
    const cues = compileRenderPlan(doc(), words).captions!.cues;
    const texts = cues.flatMap((c) => c.words.map((w) => w.text.toLowerCase()));
    expect(texts.slice(0, 3)).toEqual(["welcome", "back", "everyone"]);
    expect(cues[0].outStartSec).toBeCloseTo(0.2, 1);
    expect(cues.find((c) => c.words.some((w) => w.text.toLowerCase() === "hey"))!.outStartSec).toBeGreaterThanOrEqual(8);
  });

  it("a correction to its word doesn't rename the source word at the same time", () => {
    const d = { ...doc(), wordEdits: { [wordEditKey(0.2, "media-intro")]: "Welcome" , [wordEditKey(0)]: "Hey" } };
    expect(parseDoc(JSON.parse(JSON.stringify(d))).ok).toBe(true);
    const view = buildTranscriptView(d, words);
    expect(view.words.find((w) => w.word.mediaId)!.corrected).toBe(true);
    expect(view.words.find((w) => w.word.text === "hey")!.text).toBe("Hey");
    expect(view.words.filter((w) => w.corrected)).toHaveLength(2);
  });

  it("words trimmed off the scene leave the transcript", () => {
    const d = retimeSectionInDoc(doc(), introId, { startSec: 0.9, endSec: 8 });
    const view = buildTranscriptView(d, words);
    expect(view.words.filter((w) => w.word.mediaId).map((w) => w.text)).toEqual(["back", "everyone."]);
  });

  it("deleting the source's last word never reaches into the intro's file", () => {
    const view = buildTranscriptView(doc(), words);
    const plain = view.words.map((w) => w.word);
    const lastSource = view.words.findIndex((w) => w.word.mediaId) - 1;
    expect(rangeForWordRun(plain, lastSource, lastSource)).toEqual({ startSec: 2.4, endSec: 2.9 });
  });
});
