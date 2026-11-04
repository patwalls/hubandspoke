import { describe, expect, it } from "vitest";
import { applyLook, createDefaultDoc, createImageLayer, createTextLayer, lookFromDoc, type CaptionsLayer, type ClipEditDoc, type TextLayer } from "./doc";
import { lookChanges, rollUpLookEdits } from "./look-edits";

const look = lookFromDoc(createDefaultDoc({ startSec: 0, endSec: 30, hook: "The look's placeholder hook" }));
/** A clip as it starts: the look applied to a fresh doc with its own hook. */
const fresh = (hook = "A much longer AI hook for this particular clip that will be fitted down"): ClipEditDoc =>
  // Cloned: applyLook shares layer objects with the look (saved docs are JSON).
  structuredClone(applyLook(createDefaultDoc({ startSec: 100, endSec: 130, hook }), look));
const hookOf = (d: ClipEditDoc) => d.layers.find((l): l is TextLayer => l.type === "text" && l.role === "hook")!;
const capsOf = (d: ClipEditDoc) => d.layers.find((l): l is CaptionsLayer => l.type === "captions")!;

describe("lookChanges (what a clip changed from its format's look)", () => {
  it("an untouched clip changed nothing — its own hook words and fitted size don't count", () => {
    expect([...lookChanges(fresh(), look)]).toEqual([]);
  });

  it("a hidden hook is 'hook hidden', not also restyled or moved", () => {
    const d = fresh();
    hookOf(d).visible = false;
    hookOf(d).style.fontId = "bangers";
    expect([...lookChanges(d, look)]).toEqual(["hook-hidden"]);
  });

  it("own text and an added logo count; a framing pan does not", () => {
    const d = fresh();
    d.layers.push(createTextLayer({ text: "Everything before the demo is a pitch", canvas: d.canvas }));
    d.layers.push(createTextLayer({ text: "   ", canvas: d.canvas })); // an empty box someone left
    d.layers.push(createImageLayer({ src: { kind: "s3", bucket: "b", key: "brand-logos/x.png" }, canvas: d.canvas }));
    d.video = { ...d.video, panXPct: 12 };
    expect(new Set(lookChanges(d, look))).toEqual(new Set(["own-text", "image-added"]));
  });

  it("captions: a tiny nudge is nothing, a real move or a style change counts", () => {
    const nudged = fresh();
    capsOf(nudged).yPct += 1;
    expect(lookChanges(nudged, look).size).toBe(0);
    const d = fresh();
    capsOf(d).yPct += 10;
    capsOf(d).maxWordsPerCue = capsOf(d).maxWordsPerCue + 2;
    expect(new Set(lookChanges(d, look))).toEqual(new Set(["captions-moved", "captions-restyled"]));
  });
});

describe("rollUpLookEdits", () => {
  it("counts clips per change, most common first, and leaves out changes nobody made", () => {
    const hidden = () => {
      const d = fresh();
      hookOf(d).visible = false;
      return d;
    };
    const restyledCaps = hidden();
    capsOf(restyledCaps).style.color = "#FFE14D";
    const rows = rollUpLookEdits([hidden(), hidden(), restyledCaps, fresh()].map((doc) => ({ doc, look })));
    expect(rows).toEqual([
      { change: "hook-hidden", label: "hook hidden", clips: 3 },
      { change: "captions-restyled", label: "captions restyled", clips: 1 },
    ]);
  });
});
