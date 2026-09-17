"use client";

/**
 * Transport: play/pause, the output-time scrub bar, and the source-time trim
 * strip.
 *
 * Two different timelines on purpose. The SCRUB BAR is the clip as it will
 * export (cuts closed up). The TRIM STRIP is the raw source around the clip,
 * showing what's in, what's cut, and what's outside — with drag handles for
 * the in/out points. The strip is where a waveform goes later.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Section, TimeRange } from "@/lib/clip-editor/doc";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import type { EditorWord } from "@/lib/clip-editor/words";
import type { EngineSnapshot, PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

function fmt(sec: number): string {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** Shortest clip the trim handles will allow. */
const MIN_CLIP_SEC = 1;

export function Transport({
  plan,
  engine,
  body,
  context,
  words,
  readOnly,
}: {
  plan: RenderPlan;
  engine: PlaybackEngine;
  body: Section | null;
  context: TimeRange;
  words: EditorWord[];
  readOnly: boolean;
}) {
  const [snap, setSnap] = useState<EngineSnapshot>(() => engine.snapshot());
  useEffect(() => engine.subscribe(setSnap), [engine]);

  const scrubRef = useRef<HTMLDivElement | null>(null);
  const scrubTo = (clientX: number) => {
    const rect = scrubRef.current?.getBoundingClientRect();
    if (!rect || plan.durationSec === 0) return;
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    engine.seek(f * plan.durationSec);
  };
  const onScrubDown = (e: PointerEvent) => {
    scrubTo(e.clientX);
    const move = (ev: globalThis.PointerEvent) => scrubTo(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (sec: number) =>
    plan.durationSec > 0 ? `${(sec / plan.durationSec) * 100}%` : "0%";

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => engine.toggle()}
          aria-label={snap.playing ? "Pause" : "Play"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
        >
          {snap.playing ? (
            <PauseIcon className="size-4" fill="currentColor" />
          ) : (
            <PlayIcon className="size-4 translate-x-px" fill="currentColor" />
          )}
        </button>
        <span className="w-24 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {fmt(snap.outSec)} / {fmt(plan.durationSec)}
        </span>

        <div
          ref={scrubRef}
          onPointerDown={onScrubDown}
          className="relative h-6 flex-1 cursor-pointer touch-none"
        >
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-sky-500/80" style={{ width: pct(snap.outSec) }} />
          </div>
          {/* A tick wherever the export jumps in the source — i.e. every cut. */}
          {plan.segments.slice(1).map((seg, i) => (
            <div
              key={i}
              className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-foreground/35"
              style={{ left: pct(seg.outStartSec) }}
            />
          ))}
          <div
            className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-600 shadow ring-2 ring-background"
            style={{ left: pct(snap.outSec) }}
          />
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {plan.segments.length - 1} cut{plan.segments.length - 1 === 1 ? "" : "s"}
        </span>
      </div>

      {body && (
        <TrimStrip
          body={body}
          context={context}
          words={words}
          playheadSourceSec={
            plan.segments[snap.segmentIndex]?.sectionId === body.id ? snap.sourceSec : null
          }
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

function TrimStrip({
  body,
  context,
  words,
  playheadSourceSec,
  readOnly,
}: {
  body: Section;
  context: TimeRange;
  words: EditorWord[];
  playheadSourceSec: number | null;
  readOnly: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const ref = useRef<HTMLDivElement | null>(null);
  const lo = Math.min(context.startSec, body.startSec);
  const hi = Math.max(context.endSec, body.endSec);
  const span = Math.max(hi - lo, 0.001);
  const left = (sec: number) => `${((sec - lo) / span) * 100}%`;
  const width = (a: number, b: number) => `${((b - a) / span) * 100}%`;

  /** Snap a dragged edge to the nearest word boundary so trims never land
   *  mid-word. */
  const snap = (sec: number, edge: "start" | "end") => {
    let best = sec;
    let bestDist = 0.25; // only snap when a boundary is this close
    for (const w of words) {
      const candidate = edge === "start" ? w.startSec : w.endSec;
      const d = Math.abs(candidate - sec);
      if (d < bestDist) {
        best = candidate;
        bestDist = d;
      }
    }
    return best;
  };

  const startHandleDrag = (edge: "start" | "end") => (e: PointerEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    // Unique per gesture so two separate drags are two undo steps.
    const key = `trim-${edge}:${e.timeStamp}`;
    const move = (ev: globalThis.PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const sec = snap(lo + f * span, edge);
      apply(
        (doc) => {
          const current = doc.sections.find((s) => s.id === body.id);
          if (!current) return doc;
          const window =
            edge === "start"
              ? {
                  startSec: Math.max(0, Math.min(sec, current.endSec - MIN_CLIP_SEC)),
                  endSec: current.endSec,
                }
              : {
                  startSec: current.startSec,
                  endSec: Math.max(sec, current.startSec + MIN_CLIP_SEC),
                };
          return commands.retime(body.id, window)(doc);
        },
        key,
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="w-[8.25rem] shrink-0 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Source
      </span>
      <div ref={ref} className="relative h-7 flex-1 touch-none rounded bg-muted/60">
        {/* the clip window */}
        <div
          className="absolute inset-y-0 rounded-sm bg-sky-500/25 ring-1 ring-inset ring-sky-500/50"
          style={{ left: left(body.startSec), width: width(body.startSec, body.endSec) }}
        />
        {/* what's cut out of it */}
        {body.removals.map((r, i) => (
          <div
            key={i}
            title={`${r.reason} · ${(r.endSec - r.startSec).toFixed(1)}s`}
            className={cn(
              "absolute inset-y-0",
              r.reason === "filler" ? "bg-amber-500/60" : r.reason === "silence" ? "bg-zinc-500/50" : "bg-red-500/55",
            )}
            style={{ left: left(r.startSec), width: width(r.startSec, r.endSec) }}
          />
        ))}
        {playheadSourceSec !== null && (
          <div
            className="pointer-events-none absolute inset-y-[-3px] w-0.5 bg-sky-600"
            style={{ left: left(playheadSourceSec) }}
          />
        )}
        {(["start", "end"] as const).map((edge) => (
          <div
            key={edge}
            role="slider"
            aria-label={edge === "start" ? "Clip start" : "Clip end"}
            aria-valuenow={edge === "start" ? body.startSec : body.endSec}
            onPointerDown={startHandleDrag(edge)}
            className={cn(
              "absolute inset-y-[-4px] z-10 w-2.5 -translate-x-1/2 rounded-sm bg-sky-600 shadow",
              readOnly ? "cursor-not-allowed opacity-50" : "cursor-ew-resize hover:bg-sky-500",
            )}
            style={{ left: left(edge === "start" ? body.startSec : body.endSec) }}
          />
        ))}
      </div>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {fmt(body.startSec)}–{fmt(body.endSec)}
      </span>
    </div>
  );
}
