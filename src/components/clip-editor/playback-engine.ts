/**
 * PlaybackEngine — plays a RenderPlan's segments back-to-back, live, straight
 * off the source file. No proxy render: an edit is audible the instant it is
 * made.
 *
 * The problem: a browser <video> can only play its file linearly, and a seek
 * costs 50–200ms. A clip with filler words removed has a cut every few
 * seconds, so "seek at every cut" stutters at every cut.
 *
 * The technique (the same one browser NLEs use): TWO <video> elements on the
 * same source. While the ACTIVE one plays the current segment, the STANDBY
 * one sits paused and pre-seeked at the start of the next segment. At the cut
 * we start the standby and swap which one is visible/audible, then re-cue the
 * old element for the cut after that. Seeks still happen — just never while
 * anyone is watching them.
 *
 * Deliberately framework-free: React renders the two elements and hands them
 * over; the engine owns play state, the clock, and element visibility. Time
 * updates go out through `subscribe` at rAF rate so they never pass through
 * React state for the whole editor.
 */
import type { PlanSegment, RenderPlan } from "@/lib/clip-editor/plan";
import { outputToSource } from "@/lib/clip-editor/plan";

/** Switch this close to a segment's end. rAF fires every ~16ms; switching a
 *  hair early keeps us from playing a frame of the removed footage. */
const SWITCH_LEAD_SEC = 0.02;
/** Two segments this close in source time are continuous — don't swap. */
const CONTIGUOUS_EPSILON_SEC = 0.02;

/**
 * "clip" plays the edit (the plan's segments, cuts skipped). "preview" plays
 * the RAW source linearly from wherever the user pointed — footage that is
 * not in the edit (the rest of the video, or words that were cut). The two
 * must never be confusable, so the mode rides on every snapshot and every
 * surface styles itself from it.
 */
export type EngineMode = "clip" | "preview";

export interface EngineSnapshot {
  mode: EngineMode;
  playing: boolean;
  outSec: number;
  durationSec: number;
  /** Source time under the playhead (for the source-time trim strip). */
  sourceSec: number | null;
  /** -1 in preview mode: the playhead isn't in any segment of the edit. */
  segmentIndex: number;
}

type Listener = (snapshot: EngineSnapshot) => void;

export class PlaybackEngine {
  private els: [HTMLVideoElement, HTMLVideoElement] | null = null;
  private active = 0;
  private segments: PlanSegment[] = [];
  private durationSec = 0;
  private segIndex = 0;
  private playing = false;
  private raf = 0;
  private listeners = new Set<Listener>();
  /** Set while the newly-active element is still finishing its seek; the
   *  old frame stays on screen until the new one can actually paint. */
  private pendingReveal = false;
  private primed = false;
  private mode: EngineMode = "clip";
  /** Where the clip playhead was when preview began — "Back to clip" and the
   *  frozen scrub bar both use it. */
  private heldOutSec = 0;

  attach(a: HTMLVideoElement, b: HTMLVideoElement): void {
    this.els = [a, b];
    this.active = 0;
    a.muted = false;
    b.muted = true;
    this.reveal();
    this.cueStandby();
  }

  detach(): void {
    this.pause();
    this.els = null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): EngineSnapshot {
    const el = this.els?.[this.active];
    if (this.mode === "preview") {
      return {
        mode: "preview",
        playing: this.playing,
        outSec: this.heldOutSec,
        durationSec: this.durationSec,
        sourceSec: el ? el.currentTime : null,
        segmentIndex: -1,
      };
    }
    const seg = this.segments[this.segIndex];
    let outSec = 0;
    let sourceSec: number | null = null;
    if (seg && el) {
      sourceSec = Math.min(
        Math.max(el.currentTime, seg.sourceStartSec),
        seg.sourceEndSec,
      );
      outSec = seg.outStartSec + (sourceSec - seg.sourceStartSec);
    }
    return {
      mode: "clip",
      playing: this.playing,
      outSec,
      durationSec: this.durationSec,
      sourceSec,
      segmentIndex: this.segIndex,
    };
  }

  /**
   * Swap in a new plan after an edit. The playhead stays on the same SOURCE
   * moment when that moment still plays; if the edit removed it, it lands
   * where playback resumes. Play state is preserved — deleting a word
   * mid-playback doesn't stop the video.
   */
  setPlan(plan: RenderPlan): void {
    if (this.mode === "preview") {
      // An edit made while auditioning (typically "Add to clip" on the words
      // being previewed) must not yank the playhead. Keep playing the source;
      // the tick loop hands off to clip mode if we're now inside the edit.
      this.segments = plan.segments;
      this.durationSec = plan.durationSec;
      this.heldOutSec = Math.min(this.heldOutSec, plan.durationSec);
      this.emit();
      return;
    }
    const before = this.snapshot();
    const prevSeg = this.segments[this.segIndex];
    this.segments = plan.segments;
    this.durationSec = plan.durationSec;

    let target = 0;
    if (prevSeg && before.sourceSec !== null) {
      const src = before.sourceSec;
      const sameSection = plan.segments.filter(
        (s) => s.sectionId === prevSeg.sectionId,
      );
      const hit =
        sameSection.find((s) => src >= s.sourceStartSec && src < s.sourceEndSec) ??
        sameSection.find((s) => s.sourceStartSec >= src);
      if (hit) {
        target =
          src >= hit.sourceStartSec
            ? hit.outStartSec + (src - hit.sourceStartSec)
            : hit.outStartSec;
      } else {
        target = Math.min(before.outSec, plan.durationSec);
      }
    }
    this.seek(target);
  }

  play(): void {
    const el = this.els?.[this.active];
    if (!el) return;
    if (this.mode === "clip") {
      if (this.segments.length === 0) return;
      // Pressing play at the very end restarts from the top.
      if (this.snapshot().outSec >= this.durationSec - 0.05) this.seek(0);
    }
    this.prime();
    this.playing = true;
    void this.els![this.active].play().catch(() => {
      this.playing = false;
      this.emit();
    });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.els?.forEach((el) => el.pause());
    this.emit();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /**
   * Audition the raw source from `sourceSec` — footage that is not in the
   * edit. Plays linearly (no cuts skipped, because nothing here is "the
   * edit") until paused, or until it runs into a segment of the clip, where
   * it hands off to clip mode mid-playback: click a few words before the
   * clip's first word and you hear the lead-in flow straight into the clip.
   */
  preview(sourceSec: number, opts: { autoplay?: boolean } = {}): void {
    if (!this.els) return;
    if (this.mode === "clip") this.heldOutSec = this.snapshot().outSec;
    this.mode = "preview";
    const el = this.els[this.active];
    this.els[1 - this.active].pause();
    el.currentTime = Math.max(0, sourceSec);
    this.emit();
    if (opts.autoplay ?? true) this.play();
  }

  /** Leave preview and return to where the clip playhead was. */
  exitPreview(): void {
    if (this.mode !== "preview") return;
    // Deliberately doesn't resume playback: leaving preview is a stop.
    this.pause();
    this.seek(this.heldOutSec);
  }

  seek(outSec: number): void {
    this.mode = "clip";
    if (!this.els || this.segments.length === 0) {
      this.emit();
      return;
    }
    const mapped = outputToSource(
      { segments: this.segments, durationSec: this.durationSec } as RenderPlan,
      outSec,
    );
    if (!mapped) return;
    this.segIndex = mapped.segmentIndex;
    const el = this.els[this.active];
    el.currentTime = mapped.sourceSec;
    this.cueStandby();
    this.emit();
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Browsers only let a media element start with sound from a user gesture.
   * The standby element's first play() happens at a cut — not a gesture — so
   * we "spend" the user's play click on it too: start it muted and pause it
   * straight away. After that it may play freely.
   */
  private prime(): void {
    if (this.primed || !this.els) return;
    this.primed = true;
    const standby = this.els[1 - this.active];
    standby.muted = true;
    void standby
      .play()
      .then(() => {
        if (this.els && standby === this.els[1 - this.active]) {
          standby.pause();
          this.cueStandby();
        }
      })
      .catch(() => {});
  }

  private tick = (): void => {
    if (!this.playing || !this.els) return;
    const el = this.els[this.active];
    if (this.mode === "preview") {
      const t = el.currentTime;
      const into = this.segments.findIndex(
        (s) => t >= s.sourceStartSec && t < s.sourceEndSec - SWITCH_LEAD_SEC,
      );
      if (into >= 0) {
        // Ran into the edit: same element, same instant — only the mode (and
        // from here on, cut-skipping) changes. No seek, so no hitch.
        this.mode = "clip";
        this.segIndex = into;
        this.cueStandby();
      } else if (el.ended) {
        this.pause();
        return;
      }
      this.emit();
      if (this.playing) this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const seg = this.segments[this.segIndex];
    if (!seg) {
      this.pause();
      return;
    }
    if (this.pendingReveal && !el.seeking && el.readyState >= 2) this.reveal();
    if (el.currentTime >= seg.sourceEndSec - SWITCH_LEAD_SEC) this.advance();
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  };

  private advance(): void {
    if (!this.els) return;
    const current = this.segments[this.segIndex];
    const next = this.segments[this.segIndex + 1];
    if (!next) {
      this.els[this.active].pause();
      this.playing = false;
      return;
    }
    this.segIndex += 1;
    const continuous =
      next.inputIndex === current.inputIndex &&
      Math.abs(next.sourceStartSec - current.sourceEndSec) < CONTIGUOUS_EPSILON_SEC;
    if (continuous) return;

    const outgoing = this.els[this.active];
    const incoming = this.els[1 - this.active];
    // The standby should already be parked here; if an edit moved the cut
    // since it was cued, correct it (costs one visible seek, once).
    if (Math.abs(incoming.currentTime - next.sourceStartSec) > 0.05) {
      incoming.currentTime = next.sourceStartSec;
    }
    incoming.muted = false;
    outgoing.muted = true;
    void incoming.play().catch(() => {});
    outgoing.pause();
    this.active = 1 - this.active;
    this.pendingReveal = true;
    if (!incoming.seeking && incoming.readyState >= 2) this.reveal();
    this.cueStandby();
  }

  /** Park the standby element at the start of the next non-contiguous cut. */
  private cueStandby(): void {
    if (!this.els) return;
    const standby = this.els[1 - this.active];
    let i = this.segIndex;
    while (i + 1 < this.segments.length) {
      const a = this.segments[i];
      const b = this.segments[i + 1];
      const continuous =
        a.inputIndex === b.inputIndex &&
        Math.abs(b.sourceStartSec - a.sourceEndSec) < CONTIGUOUS_EPSILON_SEC;
      if (!continuous) {
        standby.pause();
        standby.currentTime = b.sourceStartSec;
        return;
      }
      i += 1;
    }
  }

  private reveal(): void {
    if (!this.els) return;
    this.pendingReveal = false;
    this.els[this.active].style.opacity = "1";
    this.els[1 - this.active].style.opacity = "0";
  }

  private emit(): void {
    const snap = this.snapshot();
    this.listeners.forEach((l) => l(snap));
  }
}
