"use client";

/**
 * Getting a video slide's clip exactly right. The AI's pick is a starting
 * point; this is where a person fixes it against what was actually said:
 *
 *   - the transcript around the clip, in-clip words highlighted — click a
 *     word to start there, shift-click (or the End mode) to end after it;
 *   - a timeline of the whole video with the clip as a draggable range;
 *   - snap either edge to the sentence boundary;
 *   - play from the start / play the last three seconds, to check the cut.
 *
 * Every change goes through `patch` (undoable, autosaved) and re-seeks the
 * live preview so what you hear is what will render.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsLeftIcon, ChevronsRightIcon, PlayIcon, SkipBackIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditorWord } from "@/lib/clip-editor/words";
import type { DesignVideoElement } from "@/lib/design-editor/doc";
import { endAtWord, isWordInClip, snapEndToSentence, snapStartToSentence, startAtWord, wordsAround, type ClipRange } from "@/lib/design-editor/clip-trim";
import { formatSec } from "./inspector";

export function ClipTrimmer({
  el,
  words,
  durationSec,
  patch,
  onPlayFrom,
}: {
  el: DesignVideoElement;
  words: EditorWord[];
  /** Length of the source video (from the <video>'s metadata; 0 = unknown). */
  durationSec: number;
  patch: (fn: (e: DesignVideoElement) => DesignVideoElement, key?: string) => void;
  /** Start the preview at this CLIP second. */
  onPlayFrom: (clipSec: number) => void;
}) {
  const range = useMemo<ClipRange>(() => ({ startSec: el.startSec, endSec: el.endSec }), [el.startSec, el.endSec]);
  const [mode, setMode] = useState<"start" | "end">("start");
  const nearby = useMemo(() => wordsAround(words, range, 25), [words, range]);
  const total = Math.max(durationSec, (words[words.length - 1]?.endSec ?? 0) + 1, el.endSec + 1);
  const setRange = (next: ClipRange, key?: string) => patch((cur) => ({ ...cur, startSec: next.startSec, endSec: next.endSec }), key);

  const pickWord = (w: EditorWord, shift: boolean) => {
    const i = words.indexOf(w);
    const useEnd = mode === "end" || shift;
    const next = useEnd ? endAtWord(words, i, range) : startAtWord(words, i, range);
    setRange(next);
    onPlayFrom(useEnd ? Math.max(0, next.endSec - next.startSec - 3) : 0);
  };

  // ── Timeline drag ───────────────────────────────────────────────────────
  const trackRef = useRef<HTMLDivElement | null>(null);
  const startDrag = (e: ReactPointerEvent, edge: "start" | "end" | "both") => {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const origin = { ...range };
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const dSec = ((ev.clientX - x0) / rect.width) * total;
      let next: ClipRange = origin;
      if (edge === "start") next = { startSec: clamp(origin.startSec + dSec, 0, origin.endSec - 1), endSec: origin.endSec };
      else if (edge === "end") next = { startSec: origin.startSec, endSec: clamp(origin.endSec + dSec, origin.startSec + 1, total) };
      else {
        const len = origin.endSec - origin.startSec;
        const s = clamp(origin.startSec + dSec, 0, total - len);
        next = { startSec: s, endSec: s + len };
      }
      setRange({ startSec: round2(next.startSec), endSec: round2(next.endSec) }, `trim-${edge}-${el.id}`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const cur = { startSec: el.startSec, endSec: el.endSec };
      onPlayFrom(edge === "end" ? Math.max(0, cur.endSec - cur.startSec - 3) : 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (sec: number) => `${(clamp(sec, 0, total) / total) * 100}%`;
  const len = Math.max(0, el.endSec - el.startSec);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-background px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-medium">Trim the clip</span>
        <span className="font-mono text-muted-foreground">{formatSec(el.startSec)} → {formatSec(el.endSec)} · {len.toFixed(1)}s</span>
        <span className="ml-auto flex items-center gap-1">
          <Btn onClick={() => { const n = snapStartToSentence(words, range); setRange(n); onPlayFrom(0); }} title="Move the start back to the beginning of its sentence"><ChevronsLeftIcon className="size-3" /> Sentence start</Btn>
          <Btn onClick={() => { const n = snapEndToSentence(words, range); setRange(n); onPlayFrom(Math.max(0, n.endSec - n.startSec - 3)); }} title="Move the end forward to the end of its sentence">Sentence end <ChevronsRightIcon className="size-3" /></Btn>
          <Btn onClick={() => onPlayFrom(0)} title="Play from the start"><PlayIcon className="size-3" /> From start</Btn>
          <Btn onClick={() => onPlayFrom(Math.max(0, len - 3))} title="Play the last three seconds"><SkipBackIcon className="size-3 rotate-180" /> Last 3s</Btn>
        </span>
      </div>

      {/* Timeline */}
      <div ref={trackRef} className="relative h-6 select-none rounded bg-muted" title="Drag the band to move the clip; drag its edges to trim">
        <div className="absolute inset-y-0 cursor-grab rounded bg-sky-500/30 active:cursor-grabbing" style={{ left: pct(el.startSec), width: `${(len / total) * 100}%` }} onPointerDown={(e) => startDrag(e, "both")} />
        <div className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize rounded bg-sky-600" style={{ left: pct(el.startSec) }} onPointerDown={(e) => startDrag(e, "start")} />
        <div className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize rounded bg-sky-600" style={{ left: pct(el.endSec) }} onPointerDown={(e) => startDrag(e, "end")} />
        <span className="pointer-events-none absolute right-1 top-0.5 font-mono text-[10px] text-muted-foreground">{formatSec(total)}</span>
      </div>

      {/* Transcript */}
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Click a word to</span>
        <span className="flex rounded-md bg-muted p-0.5">
          {(["start", "end"] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={cn("rounded px-2 py-0.5 font-medium", mode === m ? "bg-background text-foreground shadow-sm" : "")}>
              {m === "start" ? "start there" : "end after it"}
            </button>
          ))}
        </span>
        <span>· shift-click always sets the end</span>
      </div>
      <div className="max-h-28 overflow-y-auto rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-[13px] leading-6">
        {nearby.length === 0 ? (
          <span className="text-muted-foreground">No transcript around this clip.</span>
        ) : (
          nearby.map((w) => {
            const inClip = isWordInClip(w, range);
            return (
              <button
                key={w.index}
                type="button"
                title={formatSec(w.startSec)}
                onClick={(e) => pickWord(w, e.shiftKey)}
                className={cn("rounded px-0.5 hover:bg-sky-200/70", inClip ? "bg-sky-100 text-foreground dark:bg-sky-900/50" : "text-muted-foreground")}
              >
                {w.text}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function Btn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted">
      {children}
    </button>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
