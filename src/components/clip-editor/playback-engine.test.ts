import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDefaultDoc } from "@/lib/clip-editor/doc";
import { compileRenderPlan } from "@/lib/clip-editor/plan";
import { addRemoval } from "@/lib/clip-editor/removals";
import { PlaybackEngine } from "./playback-engine";

/** Just enough of HTMLVideoElement for the engine. Time only moves when the
 *  test moves it — the engine reads the clock, it doesn't own it. */
function fakeVideo() {
  return {
    currentTime: 0,
    paused: true,
    muted: false,
    ended: false,
    seeking: false,
    readyState: 4,
    style: { opacity: "1" },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
}

function setup() {
  // Clip = 100–110s with 102–104 cut out → segments [100,102) and [104,110).
  const doc = createDefaultDoc({ startSec: 100, endSec: 110, hook: "h" });
  doc.sections[0] = addRemoval(doc.sections[0], { startSec: 102, endSec: 104 }, "manual");
  const plan = compileRenderPlan(doc, []);
  const a = fakeVideo();
  const b = fakeVideo();
  const engine = new PlaybackEngine();
  engine.attach(a as unknown as HTMLVideoElement, b as unknown as HTMLVideoElement);
  engine.setPlan(plan);
  const tick = () => (engine as unknown as { tick: () => void }).tick();
  return { engine, plan, a, b, tick };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

describe("PlaybackEngine — clip mode", () => {
  it("skips a cut by swapping to the pre-seeked standby element", () => {
    const { engine, a, b, tick } = setup();
    expect(b.currentTime).toBe(104); // standby parked at the next segment already
    engine.play();
    a.currentTime = 101.99;
    tick();
    expect(engine.snapshot()).toMatchObject({ mode: "clip", segmentIndex: 1 });
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(true);
    expect(engine.snapshot().outSec).toBeCloseTo(2, 5); // 2s of clip played, cut closed up
  });
});

describe("PlaybackEngine — source preview", () => {
  it("plays raw source from a moment that is not in the edit, flagged as preview", () => {
    const { engine, a } = setup();
    engine.seek(1.5);
    engine.preview(12); // minute zero-ish: far outside the clip
    const snap = engine.snapshot();
    expect(snap).toMatchObject({ mode: "preview", playing: true, sourceSec: 12, segmentIndex: -1 });
    expect(snap.outSec).toBeCloseTo(1.5, 5); // the clip playhead stays parked where it was
    expect(a.currentTime).toBe(12);
    expect(a.paused).toBe(false);
  });

  it("does NOT skip cuts while previewing — struck words are audible", async () => {
    const { engine, a, b, tick } = setup();
    engine.preview(102.5); // inside the removed range
    // First play() "primes" the standby (muted play → pause) on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    a.currentTime = 103.2;
    tick();
    expect(engine.snapshot().mode).toBe("preview");
    expect(a.paused).toBe(false);
    expect(b.paused).toBe(true);
  });

  it("hands off to clip mode, without a seek, when the preview runs into the edit", () => {
    const { engine, a, tick } = setup();
    engine.preview(98); // two seconds before the clip starts
    a.currentTime = 99.5;
    tick();
    expect(engine.snapshot().mode).toBe("preview");

    a.currentTime = 100.2;
    tick();
    const snap = engine.snapshot();
    expect(snap).toMatchObject({ mode: "clip", segmentIndex: 0, playing: true });
    expect(snap.outSec).toBeCloseTo(0.2, 5);
    expect(a.currentTime).toBe(100.2); // same element, same instant — no hitch
    expect(a.paused).toBe(false);
  });

  it("an edit made while previewing does not move the playhead", () => {
    const { engine, a } = setup();
    engine.preview(50);
    a.currentTime = 51;
    const wider = createDefaultDoc({ startSec: 100, endSec: 120, hook: "h" });
    engine.setPlan(compileRenderPlan(wider, []));
    expect(a.currentTime).toBe(51);
    expect(engine.snapshot()).toMatchObject({ mode: "preview", durationSec: 20 });
  });

  it("Back to clip returns to the parked position, stopped", () => {
    const { engine, a } = setup();
    engine.seek(3); // → source 105 (after the cut)
    engine.preview(12);
    engine.exitPreview();
    expect(engine.snapshot()).toMatchObject({ mode: "clip", playing: false });
    expect(engine.snapshot().outSec).toBeCloseTo(3, 5);
    expect(a.currentTime).toBeCloseTo(105, 5);
  });

  it("scrubbing the clip timeline leaves preview", () => {
    const { engine } = setup();
    engine.preview(12);
    engine.seek(1);
    expect(engine.snapshot().mode).toBe("clip");
  });

  it("stops at the end of the source instead of looping the rAF forever", () => {
    const { engine, a, tick } = setup();
    engine.preview(500);
    a.ended = true;
    tick();
    expect(engine.snapshot().playing).toBe(false);
  });
});
