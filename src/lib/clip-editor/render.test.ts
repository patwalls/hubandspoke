import { describe, it, expect } from "vitest";
import { createDefaultDoc, parseDoc } from "./doc";
import { compileRenderPlan } from "./plan";
import { resolveScene, activeCaptionAt } from "./scene";
import { assEscape, assTime, buildAssScript } from "./ass";
import { buildFilterGraph, buildRenderArgs, parseProgressSeconds } from "./ffmpeg-args";
import { addRemoval } from "./removals";
import { layoutTextBlock, textToLayoutWords } from "./layout";
import type { EditorWord } from "./words";

const words: EditorWord[] = ["so", "this", "works"].map((text, i) => ({
  index: i, text, startSec: 100 + i * 0.4, endSec: 100 + i * 0.4 + 0.3,
}));

function planFor(mutate?: (doc: ReturnType<typeof createDefaultDoc>) => void) {
  const doc = createDefaultDoc({ startSec: 100, endSec: 110, hook: "A hook" });
  mutate?.(doc);
  return compileRenderPlan(doc, words);
}

describe("layoutTextBlock", () => {
  const base = {
    style: createDefaultDoc({ startSec: 0, endSec: 1, hook: "" }).layers[0].style,
    canvas: { width: 1080, height: 1920 },
    xPct: 50, yPct: 30, widthPct: 86,
  };

  it("a bottom-anchored block grows upward as it wraps", () => {
    const one = layoutTextBlock({ ...base, anchor: "bottom", balance: true, words: textToLayoutWords("Short hook") });
    const many = layoutTextBlock({
      ...base, anchor: "bottom", balance: true,
      words: textToLayoutWords("This founder makes forty thousand dollars a month from one boring app"),
    });
    expect(many.lines.length).toBeGreaterThan(one.lines.length);
    expect(many.bottom).toBeCloseTo(one.bottom, 6);
    expect(many.top).toBeLessThan(one.top);
  });

  it("balances lines instead of orphaning the last word", () => {
    const text = "This founder makes forty thousand dollars a month from one app";
    const greedy = layoutTextBlock({ ...base, anchor: "top", balance: false, words: textToLayoutWords(text) });
    const balanced = layoutTextBlock({ ...base, anchor: "top", balance: true, words: textToLayoutWords(text) });
    expect(balanced.lines.length).toBe(greedy.lines.length);
    const spread = (ls: typeof greedy.lines) =>
      Math.max(...ls.map((l) => l.widthPx)) - Math.min(...ls.map((l) => l.widthPx));
    expect(spread(balanced.lines)).toBeLessThanOrEqual(spread(greedy.lines));
  });

  it("never exceeds the wrap width and honours typed line breaks", () => {
    const layout = layoutTextBlock({ ...base, anchor: "top", balance: true, words: textToLayoutWords("Line one\nLine two") });
    expect(layout.lines.map((l) => l.text)).toEqual(["Line one", "Line two"]);
    for (const l of layout.lines) expect(l.widthPx).toBeLessThanOrEqual(1080 * 0.86);
  });

  it("applies uppercase at layout time so both renderers see the same string", () => {
    const layout = layoutTextBlock({
      ...base, style: { ...base.style, uppercase: true }, anchor: "top", balance: false,
      words: textToLayoutWords("make it loud"),
    });
    expect(layout.lines[0].text).toBe("MAKE IT LOUD");
  });
});

describe("buildAssScript", () => {
  it("emits one positioned, unwrapped event per hook line for the whole clip", () => {
    const plan = planFor();
    const ass = buildAssScript(plan, resolveScene(plan));
    expect(ass).toContain("PlayResX: 1080");
    const hookEvents = ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.includes(",Text0,"));
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0]).toMatch(/\{\\an8\\q2\\pos\(540\.0,[\d.]+\)\}A hook$/);
    expect(hookEvents[0]).toContain(`,${assTime(plan.durationSec + 1)},`);
  });

  it("highlights exactly one word per caption event", () => {
    const plan = planFor();
    const captionEvents = buildAssScript(plan, resolveScene(plan))
      .split("\n").filter((l) => l.includes(",Captions,"));
    expect(captionEvents).toHaveLength(3); // one per word of the single cue
    for (const e of captionEvents) expect(e.match(/\\c&H4DE1FF&/g)).toHaveLength(1);
    expect(captionEvents[1]).toContain("SO {\\c&H4DE1FF&}THIS{\\c&HFFFFFF&} WORKS");
  });

  it("omits hidden layers and escapes override-tag characters in user text", () => {
    const plan = planFor((doc) => {
      doc.layers = doc.layers.map((l) =>
        l.type === "captions" ? { ...l, visible: false } : { ...l, text: "{\\b1}bold\\N" },
      );
    });
    const ass = buildAssScript(plan, resolveScene(plan));
    expect(ass).not.toContain("Captions");
    expect(ass).not.toContain("{\\b1}");
    expect(assEscape("a\\Nb")).not.toContain("\\N");
  });

  it("formats times as centiseconds", () => {
    expect(assTime(3661.239)).toBe("1:01:01.24");
    expect(assTime(-1)).toBe("0:00:00.00");
  });
});

describe("activeCaptionAt", () => {
  it("lights the word being spoken and nothing between cues", () => {
    const plan = planFor();
    const scene = resolveScene(plan);
    expect(activeCaptionAt(scene, 0.45)?.activeWord).toBe(1);
    expect(activeCaptionAt(scene, 5)).toBeNull();
  });
});

describe("buildFilterGraph", () => {
  it("selects identical frame ranges for video and audio", () => {
    const plan = planFor((doc) => {
      doc.sections[0] = addRemoval(doc.sections[0], { startSec: 102, endSec: 104 }, "manual");
    });
    const graph = buildFilterGraph(plan, { assPath: "/tmp/o.ass", fontsDir: "/app/fonts" });
    const predicate = "between(n,0,59)+between(n,120,299)";
    expect(graph).toContain(`select='${predicate}'`);
    expect(graph).toContain(`aselect='${predicate}'`);
    expect(graph).toContain("asetnsamples=n=1600:p=0");
    expect(graph).toContain("ass=filename='/tmp/o.ass':fontsdir='/app/fonts'");
  });

  it("letterboxes for contain and crops for cover", () => {
    expect(buildFilterGraph(planFor(), { assPath: null, fontsDir: "/f" })).toMatch(/pad=1080:1920/);
    const cover = buildFilterGraph(
      planFor((doc) => { doc.video = { fit: "cover", yPct: 50, panXPct: 25 }; }),
      { assPath: null, fontsDir: "/f" },
    );
    expect(cover).toContain("crop=1080:1920:'(iw-1080)*25/100'");
    expect(cover).not.toContain("pad=");
  });

  it("concats one input per section", () => {
    const doc = createDefaultDoc({ startSec: 100, endSec: 110, hook: "h", introRanges: [{ startSec: 1, endSec: 3 }] });
    const plan = compileRenderPlan(doc, []);
    expect(buildFilterGraph(plan, { assPath: null, fontsDir: "/f" })).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][aout]");
    const argv = buildRenderArgs({ plan, input: "https://s3/x.mp4?sig=1", filterScriptPath: "/tmp/g", outputPath: "/tmp/o.mp4" });
    expect(argv.filter((a) => a === "-i")).toHaveLength(2);
    expect(argv.indexOf("-ss")).toBeLessThan(argv.indexOf("-i")); // input seek
    expect(argv).toContain("-reconnect");
  });

  it("caps decoder, filter and encoder threads (the dyno lies about its core count)", () => {
    const argv = buildRenderArgs({ plan: planFor(), input: "/tmp/in.mp4", filterScriptPath: "/tmp/g", outputPath: "/tmp/o.mp4" });
    const i = argv.indexOf("-i");
    // decoder cap is an INPUT option: it must come before -i to apply to it
    expect(argv.slice(0, i)).toEqual(expect.arrayContaining(["-threads", "1"]));
    expect(argv[argv.indexOf("-filter_complex_threads") + 1]).toBe("1");
    expect(argv[argv.lastIndexOf("-threads") + 1]).toBe("2");
    expect(argv.lastIndexOf("-threads")).toBeGreaterThan(argv.indexOf("libx264"));
  });

  it("refuses to render an edit with no footage left", () => {
    const plan = planFor((doc) => {
      doc.sections[0] = addRemoval(doc.sections[0], { startSec: 100, endSec: 110 }, "manual");
    });
    expect(() => buildFilterGraph(plan, { assPath: null, fontsDir: "/f" })).toThrow(/Nothing to render/);
  });

  it("refuses a path that could break out of the filtergraph quoting", () => {
    expect(() => buildFilterGraph(planFor(), { assPath: "/tmp/it's.ass", fontsDir: "/f" })).toThrow(/not safe/);
  });
});

describe("parseProgressSeconds", () => {
  it("reads the latest out_time from a progress chunk", () => {
    expect(parseProgressSeconds("frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2500000\n")).toBe(2.5);
    expect(parseProgressSeconds("frame=10\n")).toBeNull();
  });
});

describe("parseDoc", () => {
  it("accepts the default doc and rejects malformed ones with a path", () => {
    const doc = createDefaultDoc({ startSec: 1, endSec: 2, hook: "h" });
    expect(parseDoc(JSON.parse(JSON.stringify(doc))).ok).toBe(true);
    const bad = parseDoc({ ...doc, sections: [{ ...doc.sections[0], endSec: 0 }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("sections.0");
    expect(parseDoc({ version: 99 }).ok).toBe(false);
  });
});

describe("createDefaultDoc hook auto-fit", () => {
  const sizeOf = (hook: string) => {
    const layer = createDefaultDoc({ startSec: 0, endSec: 10, hook }).layers[0];
    return layer.type === "text" ? layer.style.sizePct : NaN;
  };

  it("leaves a short hook at the default size", () => {
    expect(sizeOf("Bro quit Amazon to build an app")).toBe(3.6);
  });

  it("shrinks a paragraph-length hook until it fits above the video", () => {
    const long =
      "Most founders lose touch with their users as the product scales. Jay stays in his shoes instead—traveling to his app's hotspots, using it himself, and talking to the people it's built for. That's how he avoids product drift.";
    const doc = createDefaultDoc({ startSec: 0, endSec: 10, hook: long });
    expect(sizeOf(long)).toBeLessThan(3.6);
    const plan = compileRenderPlan(doc, []);
    const block = resolveScene(plan).textBlocks[0].layout;
    expect(block.top).toBeGreaterThanOrEqual(0); // on canvas
    expect(block.bottom).toBeLessThanOrEqual(1920 * 0.31 + 1);
  });
});
