"use client";

/**
 * The Descript-style timeline: a toolbar (skip, time, play, Split, zoom,
 * tools), a ruler, and a filmstrip track of the clip AS IT PLAYS, with a
 * playhead you can drag anywhere.
 *
 * Each section of the doc is one piece on the track (see lib timeline.ts).
 * Tools, as in Descript:
 *   Select (A) — click to move the playhead and pick a piece (a scene: its
 *                framing can then be changed on its own); ⌫ deletes it.
 *   Hand   (H) — drag to pan.
 *   Blade  (B) — click to cut the piece there. Split (S) cuts at the playhead.
 * Drag a piece's left / right edge (any tool) to trim it, or to extend it
 * into the footage around it — snapped to word boundaries.
 * Zoom with − / +, or ⌘/Ctrl + scroll. A plain scroll pans.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  HandIcon,
  MinusIcon,
  MousePointer2Icon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SliceIcon,
  SquareSplitHorizontalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { outputToSource, type RenderPlan } from "@/lib/clip-editor/plan";
import {
  clampZoom,
  edgeAfter,
  edgeBefore,
  pieceAt,
  rulerLabel,
  rulerStep,
  timelinePieces,
  type TimelinePiece,
} from "@/lib/clip-editor/timeline";
import { FrameCache } from "./frame-cache";
import { usePlayingSectionId } from "./framing";
import type { EditorWord } from "@/lib/clip-editor/words";
import type { EngineSnapshot, PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

type Tool = "select" | "hand" | "blade";

const TOOLS: Array<{ id: Tool; label: string; key: string; Icon: typeof HandIcon }> = [
  { id: "select", label: "Select", key: "A", Icon: MousePointer2Icon },
  { id: "hand", label: "Hand", key: "H", Icon: HandIcon },
  { id: "blade", label: "Blade", key: "B", Icon: SliceIcon },
];

/** Horizontal breathing room either side of the clip on the track. */
const PAD_PX = 12;
/** Shortest a piece can be trimmed to. */
const MIN_PIECE_SEC = 0.3;
const TRACK_H = 52;
const RULER_H = 24;

function fmt(sec: number): string {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

export function Timeline({
  plan,
  engine,
  snap,
  videoUrl,
  words,
  readOnly,
}: {
  plan: RenderPlan;
  engine: PlaybackEngine;
  snap: EngineSnapshot;
  videoUrl: string;
  words: EditorWord[];
  readOnly: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const setWordSelection = useEditor((s) => s.setWordSelection);
  const wordSelection = useEditor((s) => s.wordSelection);
  const stageSelection = useEditor((s) => s.stageSelection);
  const pieces = useMemo(() => timelinePieces(plan), [plan]);
  const [tool, setTool] = useState<Tool>("select");
  const [toolMenu, setToolMenu] = useState(false);
  const [zoom, setZoom] = useState(1);
  // The picked piece is the picked SCENE — shared, so framing edits in the
  // preview and the Video panel apply to it (see framing.ts).
  const selectedId = useEditor((s) => s.sceneSelection);
  const setSelectedId = useEditor((s) => s.setSceneSelection);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewW, setViewW] = useState(800);
  const [scrollX, setScrollX] = useState(0);

  // Created in an effect (not a memo) so a StrictMode remount can't keep a
  // cache its own cleanup already destroyed.
  const [cache, setCache] = useState<FrameCache | null>(null);
  useEffect(() => {
    const c = new FrameCache(videoUrl);
    setCache(c);
    return () => c.destroy();
  }, [videoUrl]);

  const duration = Math.max(plan.durationSec, 0.1);
  /** A scene being dragged to a new place: its offset and where it'd land. */
  const [dragMove, setDragMove] = useState<{ sectionId: string; dx: number; slot: { toIndex: number; x: number } } | null>(null);
  // While an edge is being dragged the clip's length changes under the
  // pointer; hold the scale still so the edge tracks the mouse.
  const [frozenPx, setFrozenPx] = useState<number | null>(null);
  const pxPerSec = frozenPx ?? (Math.max(viewW - PAD_PX * 2, 50) / duration) * zoom;
  const contentW = duration * pxPerSec + PAD_PX * 2;
  const xOf = (t: number) => PAD_PX + t * pxPerSec;
  const previewing = snap.mode === "preview";

  // ── Size + scroll tracking ───────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const timeAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
      return Math.min(duration, Math.max(0, (x - PAD_PX) / pxPerSec));
    },
    [duration, pxPerSec],
  );

  // Zoom keeps the moment under the anchor (cursor, or the playhead) still.
  const zoomAnchor = useRef<{ t: number; screenX: number } | null>(null);
  const zoomTo = useCallback(
    (next: number, anchorClientX?: number) => {
      const el = scrollRef.current;
      const z = clampZoom(next);
      if (!el || z === zoom) return;
      const rect = el.getBoundingClientRect();
      const screenX = anchorClientX !== undefined ? anchorClientX - rect.left : Math.min(Math.max(xOf(snap.outSec) - el.scrollLeft, 0), rect.width);
      zoomAnchor.current = { t: (el.scrollLeft + screenX - PAD_PX) / pxPerSec, screenX };
      setZoom(z);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, pxPerSec, snap.outSec],
  );
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchor.current;
    if (!el || !a) return;
    zoomAnchor.current = null;
    el.scrollLeft = PAD_PX + a.t * pxPerSec - a.screenX;
    setScrollX(el.scrollLeft);
  }, [pxPerSec]);

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms; a plain vertical wheel pans.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomTo(zoom * Math.exp(-e.deltaY * 0.01), e.clientX);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !snap.playing || previewing) return;
    const x = xOf(snap.outSec);
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 24) el.scrollLeft = x - el.clientWidth * 0.15;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.outSec, snap.playing, previewing]);

  // A deleted / re-cut piece can't stay selected.
  useEffect(() => {
    if (selectedId && !pieces.some((p) => p.sectionId === selectedId)) setSelectedId(null);
  }, [pieces, selectedId, setSelectedId]);
  // The pick follows the playhead: once it moves into another piece (playing
  // on, scrubbing, ⏭) the pick drops, so the preview never shows one scene's
  // framing while another plays.
  const playingId = usePlayingSectionId(engine, plan);
  useEffect(() => {
    if (selectedId && playingId && playingId !== selectedId) setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingId]);
  // Highlighting words in the transcript takes over from a picked piece.
  useEffect(() => {
    if (wordSelection) setSelectedId(null);
  }, [wordSelection, setSelectedId]);

  // ── Edits ───────────────────────────────────────────────────────────────
  const splitAt = useCallback(
    (outSec: number) => {
      if (readOnly) return;
      const at = outputToSource(plan, outSec);
      const seg = at ? plan.segments[at.segmentIndex] : undefined;
      if (!at || !seg) return;
      apply(commands.split(seg.sectionId, at.sourceSec));
    },
    [apply, plan, readOnly],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId || readOnly) return;
    apply(commands.deleteSection(selectedId));
    setSelectedId(null);
  }, [apply, selectedId, setSelectedId, readOnly]);

  // ── Keyboard: A / H / B tools, S split, ⌫ delete the picked piece ─────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "a") setTool("select");
      else if (k === "h") setTool("hand");
      else if (k === "b") setTool("blade");
      else if (k === "s") splitAt(engine.snapshot().outSec);
      // ⌫ deletes the picked scene only when nothing more specific is
      // selected — highlighted words or a layer / the video on the preview
      // get ⌫ first (deleting a title card must never delete its scene).
      else if ((e.key === "Backspace" || e.key === "Delete") && selectedId && !wordSelection && !stageSelection) {
        e.preventDefault();
        e.stopImmediatePropagation();
        deleteSelected();
        return;
      } else if (e.key === "Escape" && selectedId) {
        // Drop the pick, not the whole editor.
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedId(null);
        return;
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [engine, splitAt, deleteSelected, selectedId, setSelectedId, wordSelection, stageSelection]);

  /** Snap a source time to the nearest word edge within 0.2s. */
  const snapToWord = (sec: number, edge: "start" | "end") => {
    let best = sec;
    let bestDist = 0.2;
    for (const w of words) {
      const c = edge === "start" ? w.startSec : w.endSec;
      const d = Math.abs(c - sec);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  };

  /** Drag a piece's edge: the section's in / out point moves by the same
   *  amount in the source (neighbours stop it — sections never overlap). */
  const doc = useEditor((s) => s.doc);
  const startTrim = (e: ReactPointerEvent, sectionId: string, edge: "start" | "end") => {
    if (readOnly || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const section = doc.sections.find((s) => s.id === sectionId);
    if (!section) return;
    const start = { startSec: section.startSec, endSec: section.endSec };
    const x0 = e.clientX;
    const px = pxPerSec;
    setFrozenPx(px);
    setSelectedId(sectionId);
    const key = `trim-${edge}-${sectionId}:${e.timeStamp}`;
    const move = (ev: globalThis.PointerEvent) => {
      const d = (ev.clientX - x0) / px;
      const window =
        edge === "start"
          ? { startSec: Math.max(0, Math.min(snapToWord(start.startSec + d, "start"), start.endSec - MIN_PIECE_SEC)), endSec: start.endSec }
          : { startSec: start.startSec, endSec: Math.max(snapToWord(start.endSec + d, "end"), start.startSec + MIN_PIECE_SEC) };
      apply(commands.retime(sectionId, window), key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setFrozenPx(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── Pointer ─────────────────────────────────────────────────────────────
  const drag = (onMove: (ev: globalThis.PointerEvent) => void) => {
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
  };

  const scrub = (e: ReactPointerEvent) => {
    if (previewing) engine.exitPreview();
    engine.seek(timeAt(e.clientX));
    drag((ev) => engine.seek(timeAt(ev.clientX)));
  };

  const onTrackDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (tool === "hand") {
      const el = scrollRef.current;
      if (!el) return;
      const startX = e.clientX;
      const startScroll = el.scrollLeft;
      drag((ev) => {
        el.scrollLeft = startScroll - (ev.clientX - startX);
      });
      return;
    }
    const t = timeAt(e.clientX);
    if (tool === "blade") {
      splitAt(t);
      return;
    }
    setWordSelection(null);
    const grabbed = pieceAt(pieces, t);
    if (previewing) engine.exitPreview();
    engine.seek(t);
    setSelectedId(grabbed?.sectionId ?? null);
    // Drag a scene sideways to move it in the play order (Descript-style).
    // A plain click just moves the playhead and picks the scene.
    if (!grabbed || pieces.length < 2 || readOnly) return;
    const x0 = e.clientX;
    let moving = false;
    const move = (ev: globalThis.PointerEvent) => {
      if (!moving && Math.abs(ev.clientX - x0) < 6) return;
      moving = true;
      const at = timeAt(ev.clientX);
      setDragMove({ sectionId: grabbed.sectionId, dx: ev.clientX - x0, slot: dropSlot(grabbed.sectionId, at) });
    };
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragMove(null);
      if (!moving) return;
      const slot = dropSlot(grabbed.sectionId, timeAt(ev.clientX));
      apply(commands.moveSection(grabbed.sectionId, slot.toIndex));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Where a dragged scene would land if dropped at output time `t`: before
   *  the first other scene whose middle is past `t`. `toIndex` is its new
   *  index in doc.sections; `x` is where to draw the insertion line. */
  const dropSlot = (draggedId: string, t: number): { toIndex: number; x: number } => {
    const others = pieces.filter((p) => p.sectionId !== draggedId);
    const before = others.find((p) => (p.outStartSec + p.outEndSec) / 2 > t);
    const order = doc.sections.map((s) => s.id).filter((id) => id !== draggedId);
    if (!before) return { toIndex: order.length, x: xOf(others[others.length - 1]?.outEndSec ?? 0) };
    return { toIndex: order.indexOf(before.sectionId), x: xOf(before.outStartSec) };
  };

  // ── Ruler ticks (only the visible stretch) ──────────────────────────────
  const step = rulerStep(pxPerSec);
  const visT0 = Math.max(0, (scrollX - PAD_PX) / pxPerSec);
  const visT1 = Math.min(duration, (scrollX + viewW) / pxPerSec);
  const ticks: number[] = [];
  for (let t = Math.floor(visT0 / step) * step; t <= visT1 + step; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const ActiveTool = TOOLS.find((t) => t.id === tool)!;

  return (
    <div className="flex flex-col gap-1">
      {/* Toolbar */}
      <div className="flex h-9 items-center gap-2">
        <div className="flex flex-1 items-center gap-1">
          <IconButton label="Previous cut" onClick={() => engine.seek(edgeBefore(pieces, snap.outSec))}>
            <ChevronsLeftIcon className="size-4" />
          </IconButton>
          <IconButton label="Next cut" onClick={() => engine.seek(edgeAfter(pieces, snap.outSec, plan.durationSec))}>
            <ChevronsRightIcon className="size-4" />
          </IconButton>
          <span className="ml-1 font-mono text-[13px] tabular-nums">
            {previewing ? (
              <span className="text-amber-700 dark:text-amber-400">source {fmt(snap.sourceSec ?? 0)}</span>
            ) : (
              <>
                {fmt(snap.outSec)} <span className="text-muted-foreground">/ {fmt(plan.durationSec)}</span>
              </>
            )}
          </span>
          {previewing && (
            <button
              type="button"
              onClick={() => engine.exitPreview()}
              className="ml-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
            >
              Back to clip
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => engine.toggle()}
            aria-label={snap.playing ? "Pause" : "Play"}
            className={cn(
              "flex size-8 items-center justify-center rounded-full transition-transform hover:scale-105",
              previewing ? "bg-amber-400 text-black" : "bg-foreground text-background",
            )}
          >
            {snap.playing ? <PauseIcon className="size-3.5" fill="currentColor" /> : <PlayIcon className="size-3.5 translate-x-px" fill="currentColor" />}
          </button>
          <button
            type="button"
            disabled={readOnly}
            onClick={() => splitAt(snap.outSec)}
            title="Split the clip at the playhead (S)"
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium hover:bg-muted disabled:opacity-40"
          >
            <SquareSplitHorizontalIcon className="size-4" /> Split
          </button>
        </div>

        <div className="flex flex-1 items-center justify-end gap-1">
          <IconButton label="Zoom out" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= 1}>
            <MinusIcon className="size-4" />
          </IconButton>
          <button
            type="button"
            onClick={() => zoomTo(1)}
            title="Fit the whole clip"
            className="w-12 rounded px-1 text-center font-mono text-[12px] tabular-nums text-muted-foreground hover:bg-muted"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton label="Zoom in" onClick={() => zoomTo(zoom * 1.5)}>
            <PlusIcon className="size-4" />
          </IconButton>
          <div className="relative ml-1">
            <button
              type="button"
              onClick={() => setToolMenu((o) => !o)}
              title={`${ActiveTool.label} tool (${ActiveTool.key})`}
              className={cn("flex h-8 items-center gap-1 rounded-md border border-border px-2 hover:bg-muted", toolMenu && "bg-muted")}
            >
              <ActiveTool.Icon className="size-4" />
              <ChevronDownIcon className="size-3 text-muted-foreground" />
            </button>
            {toolMenu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setToolMenu(false)} />
                <div className="absolute bottom-full right-0 z-40 mb-1 w-48 rounded-lg border border-border bg-popover p-1 shadow-lg">
                  {TOOLS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setTool(t.id);
                        setToolMenu(false);
                      }}
                      className={cn("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-[13px] hover:bg-muted", tool === t.id && "bg-muted")}
                    >
                      <t.Icon className="size-4" />
                      <span className="flex-1 text-left font-medium">{t.label}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{t.key}</span>
                      <CheckIcon className={cn("size-3.5", tool !== t.id && "invisible")} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Ruler + track */}
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
        className={cn("relative select-none overflow-x-auto overflow-y-hidden rounded-md border border-border bg-muted/30 [scrollbar-width:thin]", previewing && "opacity-60")}
      >
        <div className="relative" style={{ width: contentW, height: RULER_H + TRACK_H + 10 }}>
          <div onPointerDown={scrub} className="absolute inset-x-0 top-0 cursor-pointer border-b border-border/60" style={{ height: RULER_H }}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full" style={{ left: xOf(t) }}>
                <span className="absolute left-1 top-1 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground">{rulerLabel(t, step)}</span>
                <span className="absolute bottom-0 h-2 w-px bg-muted-foreground/50" />
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className="absolute bottom-1 size-0.5 rounded-full bg-muted-foreground/40" style={{ left: (step * pxPerSec * i) / 5 }} />
                ))}
              </div>
            ))}
          </div>

          <div
            onPointerDown={onTrackDown}
            onPointerMove={(e) => setHoverSec(tool === "blade" ? timeAt(e.clientX) : null)}
            onPointerLeave={() => setHoverSec(null)}
            className={cn("absolute inset-x-0", tool === "hand" ? "cursor-grab active:cursor-grabbing" : tool === "blade" ? "cursor-crosshair" : "cursor-default")}
            style={{ top: RULER_H + 5, height: TRACK_H }}
          >
            {pieces.map((p) => (
              <PieceBlock
                key={p.sectionId}
                piece={p}
                left={xOf(p.outStartSec)}
                width={Math.max((p.outEndSec - p.outStartSec) * pxPerSec, 2)}
                pxPerSec={pxPerSec}
                visible={[scrollX - xOf(p.outStartSec) - 200, scrollX + viewW - xOf(p.outStartSec) + 200]}
                plan={plan}
                cache={cache}
                selected={p.sectionId === selectedId}
                readOnly={readOnly}
                titles={doc.layers.filter((l) => (l.type === "text" || l.type === "image") && l.sectionId === p.sectionId).length}
                onTrimStart={(e, edge) => startTrim(e, p.sectionId, edge)}
                dragOffset={dragMove?.sectionId === p.sectionId ? dragMove.dx : null}
              />
            ))}
            {dragMove && (
              <div className="pointer-events-none absolute inset-y-[-6px] z-20 w-1 -translate-x-1/2 rounded-full bg-violet-600 shadow" style={{ left: dragMove.slot.x }} />
            )}
            {hoverSec !== null && (
              <div className="pointer-events-none absolute inset-y-[-4px] w-0.5 bg-rose-500" style={{ left: xOf(hoverSec) - 1 }} />
            )}
          </div>

          {/* Playhead */}
          {!previewing && (
            <div className="pointer-events-none absolute top-0 z-10 h-full" style={{ left: xOf(snap.outSec) }}>
              <div className="absolute -left-[5px] top-0 size-2.5 rounded-b-full bg-sky-600" />
              <div className="absolute -left-px top-0 h-full w-0.5 bg-sky-600" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PieceBlock({
  piece,
  left,
  width,
  pxPerSec,
  visible,
  plan,
  cache,
  selected,
  readOnly,
  titles,
  onTrimStart,
  dragOffset,
}: {
  piece: TimelinePiece;
  left: number;
  width: number;
  pxPerSec: number;
  /** Visible x-range, relative to the block's left edge. */
  visible: [number, number];
  plan: RenderPlan;
  cache: FrameCache | null;
  selected: boolean;
  readOnly: boolean;
  /** Title cards / subtitles that belong to this scene. */
  titles: number;
  onTrimStart: (e: ReactPointerEvent, edge: "start" | "end") => void;
  /** Pixels it's being dragged sideways (null = not being dragged). */
  dragOffset: number | null;
}) {
  const version = useSyncExternalStore(cache?.subscribe ?? noopSubscribe, cache?.getVersion ?? zero, zero);
  const tileH = TRACK_H - 4;
  const tileW = Math.max(24, Math.round(tileH * (cache?.aspect ?? 16 / 9)));
  // Coarser frame times when zoomed out, so tiles share cached frames.
  const tileSec = tileW / pxPerSec;
  const quantum = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60].find((q) => q >= tileSec * 0.8) ?? 60;

  const tiles: Array<{ x: number; sec: number }> = [];
  const first = Math.max(0, Math.floor(visible[0] / tileW));
  const last = Math.min(Math.ceil(width / tileW), Math.ceil(visible[1] / tileW));
  for (let k = first; k < last; k++) {
    const outSec = piece.outStartSec + Math.min((k * tileW + tileW / 2) / pxPerSec, piece.outEndSec - piece.outStartSec - 0.01);
    const src = outputToSource(plan, outSec)?.sourceSec;
    if (src === undefined) continue;
    tiles.push({ x: k * tileW, sec: Math.round(src / quantum) * quantum });
  }

  return (
    <div
      className={cn(
        "absolute inset-y-0 overflow-hidden rounded-md bg-zinc-900 ring-1 ring-inset",
        selected ? "ring-2 ring-sky-500" : "ring-black/20",
      )}
      style={{
        left,
        width: Math.max(width - 2, 1),
        ...(dragOffset !== null ? { transform: `translateX(${dragOffset}px) translateY(-4px)`, opacity: 0.85, zIndex: 15, boxShadow: "0 8px 20px rgba(0,0,0,.35)", cursor: "grabbing" } : {}),
      }}
    >
      {tiles.map((t) => (
        <Thumb key={t.x} cache={cache} sec={t.sec} x={t.x} w={tileW} h={tileH} version={version} />
      ))}
      {piece.seams.map((s) => (
        <div key={s} className="absolute inset-y-0 w-px bg-white/70" style={{ left: (s - piece.outStartSec) * pxPerSec }} title="Cut" />
      ))}
      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 font-mono text-[9px] font-semibold leading-3.5 text-white">{piece.index}</span>
      {width > 70 && (
        <span className="absolute bottom-0.5 right-2 rounded bg-black/60 px-1 font-mono text-[9px] font-semibold leading-3.5 text-white">
          {(piece.outEndSec - piece.outStartSec).toFixed(1)}s
        </span>
      )}
      {titles > 0 && (
        <span
          title={`${titles} text / logo element${titles === 1 ? "" : "s"} in this scene only`}
          className="absolute left-0.5 top-0.5 rounded bg-violet-600 px-1 font-mono text-[9px] font-bold leading-3.5 text-white"
        >
          T{titles > 1 ? `×${titles}` : ""}
        </span>
      )}
      {selected && <div className="pointer-events-none absolute inset-0 bg-sky-500/15" />}
      {!readOnly &&
        (["start", "end"] as const).map((edge) => (
          <div
            key={edge}
            data-trim-edge={edge}
            title={edge === "start" ? "Drag to trim or extend the start" : "Drag to trim or extend the end"}
            onPointerDown={(e) => onTrimStart(e, edge)}
            className={cn(
              "group absolute inset-y-0 z-10 flex w-2.5 cursor-ew-resize items-center justify-center",
              edge === "start" ? "left-0" : "right-0",
            )}
          >
            <span className={cn("h-5 w-1 rounded-full bg-white/80 shadow transition-opacity group-hover:opacity-100", selected ? "opacity-100" : "opacity-0")} />
          </div>
        ))}
    </div>
  );
}

function Thumb({ cache, sec, x, w, h, version }: { cache: FrameCache | null; sec: number; x: number; w: number; h: number; version: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  useEffect(() => {
    const c = ref.current;
    if (!c || !cache) return;
    const ctx = c.getContext("2d");
    const frame = cache.get(sec);
    if (!frame) {
      ctx?.clearRect(0, 0, c.width, c.height);
      cache.request(sec);
      return;
    }
    ctx?.drawImage(frame, 0, 0, c.width, c.height);
  }, [cache, sec, version]);
  return (
    <canvas
      ref={ref}
      width={Math.round(w * dpr)}
      height={Math.round(h * dpr)}
      className="pointer-events-none absolute top-0.5 border-r border-black/40 bg-zinc-800"
      style={{ left: x, width: w, height: h }}
    />
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-foreground hover:bg-muted disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const noopSubscribe = () => () => {};
const zero = () => 0;
