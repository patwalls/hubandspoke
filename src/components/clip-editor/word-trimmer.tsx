"use client";

/**
 * The word popover — double-click a kept word to get it. A strip of the
 * audio around the word with two handles, IN and OUT, that you drag (or
 * nudge with ← →) to cut a blip off either side: the breath after "that.",
 * the onset of the next line, a click before the first word. Every change
 * plays the join back. The spelling field is here too, so double-click still
 * fixes a caption word. Model in src/lib/clip-editor/word-trim.ts.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { clampWordTrim, stepWordTrim, type WordTrimWindow } from "@/lib/clip-editor/word-trim";

/** Seconds shown either side of the window, so the neighbours are visible. */
const MARGIN_SEC = 0.3;
const NUDGE_SEC = 0.02;

export function WordTrimmer({
  win,
  text,
  onTrim,
  onText,
  onAudition,
  onClose,
}: {
  win: WordTrimWindow;
  text: string;
  /** Commit new cut points (undoable; the caller plays the join). */
  onTrim: (inSec: number, outSec: number) => void;
  onText: (text: string) => void;
  onAudition: () => void;
  onClose: () => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // While dragging, the handles follow the pointer here; the doc is written
  // once on release so one drag is one undo step.
  const [live, setLive] = useState<{ inSec: number; outSec: number } | null>(null);
  // Derived-state pattern: the field follows the word until the user types.
  const [spelling, setSpellingState] = useState({ base: text, value: text });
  if (spelling.base !== text) setSpellingState({ base: text, value: text });
  const setSpelling = (value: string) => setSpellingState((s) => ({ ...s, value }));
  const inSec = live?.inSec ?? win.inSec;
  const outSec = live?.outSec ?? win.outSec;

  const from = win.minSec - MARGIN_SEC;
  const to = win.maxSec + MARGIN_SEC;
  const pct = (sec: number) => `${((sec - from) / (to - from)) * 100}%`;

  const drag = (edge: "in" | "out") => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const strip = stripRef.current;
    if (!strip) return;
    const width = strip.getBoundingClientRect().width;
    const startX = e.clientX;
    const start = { inSec, outSec };
    let last = start;
    const move = (ev: PointerEvent) => {
      const dSec = ((ev.clientX - startX) / width) * (to - from);
      last = clampWordTrim(win, edge === "in" ? start.inSec + dSec : start.inSec, edge === "out" ? start.outSec + dSec : start.outSec);
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (last.inSec !== win.inSec || last.outSec !== win.outSec) onTrim(last.inSec, last.outSec);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nudge = (edge: "in" | "out", dir: -1 | 1, big: boolean) => {
    const d = dir * (big ? NUDGE_SEC * 5 : NUDGE_SEC);
    const c = clampWordTrim(win, edge === "in" ? win.inSec + d : win.inSec, edge === "out" ? win.outSec + d : win.outSec);
    if (c.inSec !== win.inSec || c.outSec !== win.outSec) onTrim(c.inSec, c.outSec);
  };
  const step = (edge: "start" | "end") => {
    const next = stepWordTrim(win, edge);
    if (next) onTrim(next.inSec, next.outSec);
  };

  const cutIn = inSec - win.minSec;
  const cutOut = win.maxSec - outSec;

  return (
    <div
      role="dialog"
      aria-label="Trim word"
      className="w-[360px] rounded-lg border border-border bg-popover p-2.5 text-xs shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          value={spelling.value}
          onChange={(e) => setSpelling(e.target.value)}
          onBlur={() => spelling.value.trim() !== text && onText(spelling.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onText(spelling.value);
              onClose();
            }
          }}
          aria-label="Word text"
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="button" onClick={onAudition} title="Play the join" className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-muted">
          <PlayIcon className="size-3.5" />
        </button>
      </div>

      {/* The strip: neighbours as blocks, cut regions shaded, two handles. */}
      <div
        ref={stripRef}
        className="relative h-14 select-none overflow-hidden rounded-md border border-border bg-muted/40"
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {win.neighbours.map((n, i) => (
          <div
            key={i}
            className={cn(
              "absolute top-1 flex h-6 items-center justify-center overflow-hidden rounded-sm px-1 text-[11px] font-medium",
              n.self ? "bg-sky-500 text-white" : "bg-foreground/10 text-muted-foreground",
            )}
            style={{ left: pct(n.startSec), width: `calc(${pct(n.endSec)} - ${pct(n.startSec)})` }}
            title={`${n.text} ${n.startSec.toFixed(2)}–${n.endSec.toFixed(2)}`}
          >
            <span className="truncate">{n.text}</span>
          </div>
        ))}
        {/* what plays */}
        <div className="absolute bottom-0 top-0 bg-emerald-400/15" style={{ left: pct(inSec), width: `calc(${pct(outSec)} - ${pct(inSec)})` }} />
        {/* what is cut, inside the window */}
        <div className="absolute bottom-0 top-0 bg-[repeating-linear-gradient(135deg,rgba(244,63,94,0.25)_0_4px,transparent_4px_8px)]" style={{ left: pct(win.minSec), width: `calc(${pct(inSec)} - ${pct(win.minSec)})` }} />
        <div className="absolute bottom-0 top-0 bg-[repeating-linear-gradient(135deg,rgba(244,63,94,0.25)_0_4px,transparent_4px_8px)]" style={{ left: pct(outSec), width: `calc(${pct(win.maxSec)} - ${pct(outSec)})` }} />
        {/* beyond the window: the neighbours' own territory */}
        <div className="absolute bottom-0 left-0 top-0 bg-background/60" style={{ width: pct(win.minSec) }} />
        <div className="absolute bottom-0 right-0 top-0 bg-background/60" style={{ left: pct(win.maxSec) }} />
        {(["in", "out"] as const).map((edge) => {
          const sec = edge === "in" ? inSec : outSec;
          return (
            <button
              key={edge}
              type="button"
              aria-label={edge === "in" ? "Start of what plays" : "End of what plays"}
              title={`${edge === "in" ? "In" : "Out"} ${sec.toFixed(2)}s — drag, or ← → (⇧ for 0.1s)`}
              onPointerDown={drag(edge)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  nudge(edge, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
                }
              }}
              className={cn(
                "absolute bottom-0 top-0 w-3 -translate-x-1/2 cursor-ew-resize outline-none",
                "before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-rose-500",
                "after:absolute after:bottom-0.5 after:left-1/2 after:size-3 after:-translate-x-1/2 after:rounded-full after:bg-rose-500 focus-visible:after:ring-2 focus-visible:after:ring-ring",
              )}
              style={{ left: pct(sec) }}
            />
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <button type="button" onClick={() => step("start")} className="whitespace-nowrap rounded border border-border px-1.5 py-0.5 hover:bg-muted" title="Cut the gap before the word, then shave its start">
          ◁ start{cutIn > 0.004 ? ` −${cutIn.toFixed(2)}s` : ""}
        </button>
        <button type="button" onClick={() => step("end")} className="whitespace-nowrap rounded border border-border px-1.5 py-0.5 hover:bg-muted" title="Cut the gap after the word, then shave its end">
          end ▷{cutOut > 0.004 ? ` −${cutOut.toFixed(2)}s` : ""}
        </button>
        <span className="ml-auto text-right leading-tight">Drag the handles to what should play</span>
      </div>
    </div>
  );
}
