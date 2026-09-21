import { describe, it, expect } from "vitest";
import { createDefaultDoc, createImageLayer, parseDoc, type TextLayer } from "./doc";
import { compileRenderPlan } from "./plan";
import { resolveScene, activeCaptionAt } from "./scene";
import { assEscape, assTime, buildAssScript } from "./ass";
import { buildFilterGraph, buildRenderArgs, parseProgressSeconds } from "./ffmpeg-args";
import { addRemoval } from "./removals";
import { layoutTextBlock, textToLayoutWords } from "./layout";
import { parseSourceDimensions, resolveVideoBox } from "./video-box";
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
    style: (createDefaultDoc({ startSec: 0, endSec: 1, hook: "" }).layers[0] as TextLayer).style,
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

  it("without a probed source size, falls back to aspect expressions", () => {
    expect(buildFilterGraph(planFor(), { assPath: null, fontsDir: "/f" })).toMatch(/pad=1080:1920/);
    const cover = buildFilterGraph(
      planFor((doc) => { doc.video = { ...doc.video, fit: "cover", panXPct: 25 }; }),
      { assPath: null, fontsDir: "/f" },
    );
    expect(cover).toContain("crop=1080:1920:'(iw-1080)*25/100'");
    expect(cover).not.toContain("pad=");
  });

  const HD = { width: 1920, height: 1080 };

  it("with a source size, places the video at exact pixels", () => {
    const fit = buildFilterGraph(planFor(), { assPath: null, fontsDir: "/f", sourceSize: HD });
    expect(fit).toContain("scale=1080:608:flags=lanczos");
    expect(fit).toContain("pad=1080:1920:0:656:color=0x000000");

    const cover = buildFilterGraph(
      planFor((doc) => { doc.video = { ...doc.video, fit: "cover", panXPct: 25 }; }),
      { assPath: null, fontsDir: "/f", sourceSize: HD },
    );
    expect(cover).toContain("scale=3414:1920");
    expect(cover).toContain("crop=1080:1920:584:0"); // 25% of the 2334px overflow
  });

  it("insets the video when scaled below fit", () => {
    const g = buildFilterGraph(
      planFor((doc) => { doc.video = { ...doc.video, scalePct: 90 }; }),
      { assPath: null, fontsDir: "/f", sourceSize: HD },
    );
    expect(g).toContain("scale=972:546");
    expect(g).toContain("pad=1080:1920:54:687"); // centered: (1080-972)/2, 960-273
  });

  it("overlays image layers between the placed video and the text, as extra inputs", () => {
    const logo = createImageLayer({ src: { kind: "asset", path: "/watermarks/x.png" }, canvas: { width: 1080, height: 1920 } });
    const plan = planFor((doc) => {
      doc.layers.push({ ...logo, xPct: 50, yPct: 90, anchor: "bottom", widthPct: 20, opacity: 0.5 });
      doc.layers.push({ ...logo, id: "hidden", visible: false });
    });
    expect(plan.imageLayers).toHaveLength(1);
    const g = buildFilterGraph(plan, { assPath: "/tmp/o.ass", fontsDir: "/f", sourceSize: HD });
    // one video input (index 0) → the logo is input 1, scaled by width only
    expect(g).toContain("[1:v]format=rgba,scale=216:-1:flags=lanczos,colorchannelmixer=aa=0.500[img0]");
    expect(g).toContain("[vplaced][img0]overlay=x=540-overlay_w/2:y=1728-overlay_h[vi0]");
    // text burns in AFTER the logo, so it always sits on top
    expect(g).toContain("[vi0]null,ass=filename='/tmp/o.ass'");
    const argv = buildRenderArgs({ plan, input: "/tmp/in.mp4", images: ["/tmp/logo.png"], filterScriptPath: "/tmp/g", outputPath: "/tmp/o.mp4" });
    const inputs = argv.map((a, i) => (a === "-i" ? argv[i + 1] : null)).filter(Boolean);
    expect(inputs).toEqual(["/tmp/in.mp4", "/tmp/logo.png"]);
    // without a probed size the same overlay applies to the fallback placement
    expect(buildFilterGraph(plan, { assPath: null, fontsDir: "/f" })).toContain("[vplaced][img0]overlay");
  });

  it("rounds corners with a one-frame looped alpha mask, not per-frame geq", () => {
    const g = buildFilterGraph(
      planFor((doc) => { doc.video = { ...doc.video, scalePct: 90, radiusPct: 10 }; }),
      { assPath: "/tmp/o.ass", fontsDir: "/f", sourceSize: HD },
    );
    expect(g).toContain("s=972x546");
    expect(g).toContain("trim=end_frame=1");
    expect(g).toContain("loop=loop=-1:size=1");
    // every generated stream is bounded to the clip length — an unbounded
    // mask/background makes ffmpeg encode forever (it did, in development)
    expect(g.match(/trim=end_frame=300/g)).toHaveLength(2);
    expect(g).toContain("alphamerge");
    expect(g).toContain("overlay=x=54:y=687:shortest=1");
    expect(g).toMatch(/clip\(55\+0\.5-hypot/); // radius = 10% of the 546px short side
    // text is burned in AFTER compositing, so it is never masked
    expect(g.indexOf("ass=")).toBeGreaterThan(g.indexOf("overlay="));
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

describe("resolveVideoBox", () => {
  const canvas = { width: 1080, height: 1920 };
  const base = { fit: "contain" as const, yPct: 50, panXPct: 50, scalePct: 100, radiusPct: 0 };

  it("always yields even dimensions (yuv420 / libx264 reject odd ones)", () => {
    for (const scalePct of [100, 97, 93, 61, 33]) {
      const box = resolveVideoBox(canvas, { ...base, scalePct }, { width: 1920, height: 1080 });
      expect(box.width % 2).toBe(0);
      expect(box.height % 2).toBe(0);
    }
  });

  it("keeps an inset video on the canvas when dragged to an edge", () => {
    const top = resolveVideoBox(canvas, { ...base, scalePct: 80, yPct: 0 }, { width: 1920, height: 1080 });
    const bottom = resolveVideoBox(canvas, { ...base, scalePct: 80, yPct: 100 }, { width: 1920, height: 1080 });
    expect(top.y).toBe(0);
    expect(bottom.y + bottom.height).toBe(1920);
  });

  it("fits a portrait source by height", () => {
    const box = resolveVideoBox({ width: 1920, height: 1080 }, base, { width: 1080, height: 1920 });
    expect(box).toMatchObject({ height: 1080, width: 608, x: 656 });
  });

  it("never rounds a cover video — it fills the canvas", () => {
    const box = resolveVideoBox(canvas, { ...base, fit: "cover", radiusPct: 30 }, { width: 1920, height: 1080 });
    expect(box.radius).toBe(0);
  });
});

describe("parseSourceDimensions", () => {
  it("reads the first video stream from an ffmpeg banner", () => {
    const banner = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'https://s3/x.mp4':
  Duration: 00:08:44.11, start: 0.000000, bitrate: 1493 kb/s
    Stream #0:0(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)
    Stream #0:1(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 1357 kb/s, 29.97 fps, 29.97 tbr, 30k tbn, 59.94 tbc (default)
At least one output file must be specified`;
    expect(parseSourceDimensions(banner)).toEqual({ width: 1920, height: 1080 });
  });

  it("swaps dimensions for a rotated phone clip, in both banner dialects", () => {
    const modern = `    Stream #0:0(eng): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv), 1920x1080, 8000 kb/s, 30 fps (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
    Stream #0:1(eng): Audio: aac`;
    const old = `    Stream #0:0(eng): Video: h264 (High), yuv420p, 1920x1080, 30 fps (default)
    Metadata:
      rotate          : 90
    Stream #0:1(eng): Audio: aac`;
    expect(parseSourceDimensions(modern)).toEqual({ width: 1080, height: 1920 });
    expect(parseSourceDimensions(old)).toEqual({ width: 1080, height: 1920 });
  });

  it("does not read a later stream's rotation, or hex codec tags, as the size", () => {
    const banner = `    Stream #0:0: Video: h264 (avc1 / 0x31637661), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 25 fps
    Stream #0:1: Video: mjpeg, yuvj420p, 90x160 (attached pic)
      displaymatrix: rotation of 90.00 degrees`;
    expect(parseSourceDimensions(banner)).toEqual({ width: 1280, height: 720 });
    expect(parseSourceDimensions("no streams here")).toBeNull();
  });
});

describe("saved docs from before video inset/rounding existed", () => {
  it("still parse, defaulting to fit with square corners", () => {
    const doc = JSON.parse(JSON.stringify(createDefaultDoc({ startSec: 1, endSec: 2, hook: "h" })));
    delete doc.video.scalePct;
    delete doc.video.radiusPct;
    const parsed = parseDoc(doc);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.doc.video).toMatchObject({ scalePct: 100, radiusPct: 0 });
  });
});
