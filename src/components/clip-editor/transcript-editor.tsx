"use client";

/**
 * The transcript IS the timeline — and it is the WHOLE source video, top to
 * bottom. Dark words play; dim words are outside the clip; struck words were
 * cut. Highlight any words and a toolbar appears right at the highlight:
 *
 *   dark words   → Remove   (struck through, gone from the export)
 *   struck words → Restore
 *   dim words    → Add to clip (scroll up and pull in the intro, a later
 *                  punchline, anything)
 *
 * Performance notes, since a podcast is 10k+ words:
 *   - words render in memoized CHUNKS; a selection change only re-renders the
 *     chunks it touches, and offscreen chunks skip layout/paint entirely
 *     (`content-visibility: auto`);
 *   - mouse interaction is event-delegated from the container (`data-pos`);
 *   - the "now playing" highlight is a DOM data-attribute toggled from the
 *     engine clock, so playback never re-renders React at all.
 */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { PlusIcon, RotateCcwIcon, ScissorsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClipEditDoc } from "@/lib/clip-editor/doc";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import { sourceToOutput } from "@/lib/clip-editor/plan";
import {
  selectionActions,
  type TranscriptView,
  type ViewGap,
  type ViewToken,
  type ViewWord,
} from "@/lib/clip-editor/transcript-view";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

const WORDS_PER_CHUNK = 90;

function fmt(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

interface Chunk {
  key: string;
  tokens: ViewToken[];
  firstPos: number;
  lastPos: number;
}

function chunkTokens(tokens: ViewToken[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: ViewToken[] = [];
  let firstPos = -1;
  let lastPos = -1;
  let count = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ key: `c${chunks.length}`, tokens: current, firstPos, lastPos });
    current = [];
    firstPos = -1;
    count = 0;
  };
  for (const t of tokens) {
    // Never start a chunk with a pause chip — keep it with the word before.
    if (count >= WORDS_PER_CHUNK && t.kind !== "gap") flush();
    current.push(t);
    if (t.kind === "word") {
      if (firstPos < 0) firstPos = t.pos;
      lastPos = t.pos;
      count++;
    }
  }
  flush();
  return chunks;
}

export function TranscriptEditor({
  view,
  doc,
  plan,
  engine,
  readOnly,
}: {
  view: TranscriptView;
  doc: ClipEditDoc;
  plan: RenderPlan;
  engine: PlaybackEngine;
  readOnly: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.wordSelection);
  const setSelection = useEditor((s) => s.setWordSelection);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** A mousedown on a not-in-edit word that may still turn into a drag. */
  const clickRef = useRef<{ pos: number; sourceSec: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number; below: boolean } | null>(null);

  const chunks = useMemo(() => chunkTokens(view.tokens), [view]);
  const lo = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const hi = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const actions = useMemo(
    () => (selection ? selectionActions(view, doc, lo, hi) : null),
    [view, doc, selection, lo, hi],
  );

  // ── "Now playing" highlight, outside React ───────────────────────────────
  // A data attribute, not a class: React owns `className` and would wipe a
  // class we added the next time a chunk re-renders.
  const keptBySection = useMemo(() => {
    const map = new Map<string, ViewWord[]>();
    for (const w of view.words) {
      if (w.state !== "kept" || !w.sectionId) continue;
      const list = map.get(w.sectionId);
      if (list) list.push(w);
      else map.set(w.sectionId, [w]);
    }
    return map;
  }, [view]);
  const liveRef = useRef({ keptBySection, plan, words: view.words });
  useEffect(() => {
    liveRef.current = { keptBySection, plan, words: view.words };
  }, [keptBySection, plan, view]);

  useEffect(() => {
    let activeEl: Element | null = null;
    return engine.subscribe((snap) => {
      const seg = liveRef.current.plan.segments[snap.segmentIndex];
      let next: Element | null = null;
      // In preview the playhead is on raw source, so ANY word can be the
      // current one; in clip mode only kept words of the playing section.
      const list =
        snap.mode === "preview"
          ? liveRef.current.words
          : seg
            ? (liveRef.current.keptBySection.get(seg.sectionId) ?? [])
            : [];
      if (list.length > 0 && snap.sourceSec !== null) {
        // Binary search: last word that has started by now.
        let a = 0;
        let b = list.length - 1;
        let hit = -1;
        const t = snap.sourceSec + 0.02;
        while (a <= b) {
          const mid = (a + b) >> 1;
          if (list[mid].word.startSec <= t) {
            hit = mid;
            a = mid + 1;
          } else b = mid - 1;
        }
        if (hit >= 0) {
          next = scrollRef.current?.querySelector(`[data-pos="${list[hit].pos}"]`) ?? null;
        }
      }
      // "true" = playing the edit (blue); "preview" = auditioning footage
      // that is NOT in the edit (amber). Same word can flip between the two
      // at the hand-off, so compare the value too.
      const flag = snap.mode === "preview" ? "preview" : "true";
      if (next !== activeEl || (next && next.getAttribute("data-active") !== flag)) {
        activeEl?.removeAttribute("data-active");
        next?.setAttribute("data-active", flag);
        activeEl = next;
        // Follow playback, but never yank the view while the user is parked.
        if (next && snap.playing) next.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  }, [engine]);

  // Open on the clip, not on minute zero of the source. If an earlier part
  // (an intro) is also in the clip, open on the LONGEST part — the body.
  useEffect(() => {
    const longest = [...doc.sections].sort(
      (a, b) => b.endSec - b.startSec - (a.endSec - a.startSec),
    )[0];
    const first = view.words.find((w) => w.sectionId === longest?.id);
    if (!first) return;
    scrollRef.current
      ?.querySelector(`[data-pos="${first.pos}"]`)
      ?.scrollIntoView({ block: "start" });
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Selection by click / shift-click / drag ─────────────────────────────
  const posFromEvent = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest("[data-pos]");
    return el ? Number(el.getAttribute("data-pos")) : null;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const pos = posFromEvent(e);
    if (pos === null) {
      if (!(e.target as HTMLElement).closest("[data-gap]")) setSelection(null);
      return;
    }
    e.preventDefault(); // we draw our own highlight; suppress the native one
    draggingRef.current = true;
    setDragging(true);
    if (e.shiftKey && selection) setSelection({ anchor: selection.anchor, focus: pos });
    else setSelection({ anchor: pos, focus: pos });
    const w = view.words[pos];
    clickRef.current = null;
    if (!w || e.shiftKey) return;
    if (w.state === "kept") {
      const out = sourceToOutput(plan, w.word.startSec + 0.001, w.sectionId ?? undefined);
      if (out !== null) engine.seek(out);
    } else {
      // Not in the edit (rest of the video, or a cut word): audition it. But
      // only on a plain CLICK — decided at mouseup — so dragging a highlight
      // across dim words to add them doesn't start the video blaring.
      clickRef.current = { pos, sourceSec: w.word.startSec };
    }
  };

  const onMouseOver = (e: MouseEvent) => {
    if (!draggingRef.current || !selection) return;
    const pos = posFromEvent(e);
    if (pos !== null && pos !== selection.focus) {
      clickRef.current = null; // it became a drag
      setSelection({ anchor: selection.anchor, focus: pos });
    }
  };

  useEffect(() => {
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      const click = clickRef.current;
      clickRef.current = null;
      if (click) engine.preview(click.sourceSec);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [engine]);

  const onDoubleClick = (e: MouseEvent) => {
    if (readOnly) return;
    const pos = posFromEvent(e);
    if (pos !== null && view.words[pos]?.state !== "outside") {
      setSelection(null);
      setEditingPos(pos);
    }
  };

  // ── Floating toolbar placement ──────────────────────────────────────────
  // Sits just above the word where the highlight ENDED (where the cursor
  // is), flipping below when there is no room. Hidden mid-drag so it never
  // chases the mouse.
  const placeToolbar = useCallback(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller || !selection || dragging) return setToolbar(null);
    const el = scroller.querySelector(`[data-pos="${selection.focus}"]`);
    if (!el) return setToolbar(null);
    const word = el.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    if (word.bottom < port.top || word.top > port.bottom) return setToolbar(null);
    const below = word.top - port.top < 52;
    setToolbar({
      top: (below ? word.bottom + 6 : word.top - 6) - box.top,
      left: Math.min(Math.max(word.left + word.width / 2 - box.left, 130), box.width - 130),
      below,
    });
  }, [selection, dragging]);

  useLayoutEffect(placeToolbar, [placeToolbar, view]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", placeToolbar, { passive: true });
    window.addEventListener("resize", placeToolbar);
    return () => {
      scroller.removeEventListener("scroll", placeToolbar);
      window.removeEventListener("resize", placeToolbar);
    };
  }, [placeToolbar]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const run = useCallback(
    (mutate: (d: ClipEditDoc) => ClipEditDoc) => {
      if (readOnly) return;
      apply(mutate);
      setSelection(null);
    },
    [apply, readOnly, setSelection],
  );

  const removeSelection = useCallback(() => {
    if (!actions) return;
    run((d) =>
      actions.ranges.reduce((acc, r) => commands.remove(r.sectionId, [r.range], "manual")(acc), d),
    );
  }, [actions, run]);

  const restoreSelection = useCallback(() => {
    if (!actions) return;
    run((d) => actions.ranges.reduce((acc, r) => commands.restore(r.sectionId, [r.range])(acc), d));
  }, [actions, run]);

  const addSelection = useCallback(() => {
    if (!actions) return;
    run(commands.include(actions.include));
  }, [actions, run]);

  // ⌫ / Delete removes (or restores); Enter adds dim words to the clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (!actions) return;
      if ((e.key === "Backspace" || e.key === "Delete") && actions.ranges.length) {
        e.preventDefault();
        if (actions.allRemoved) restoreSelection();
        else removeSelection();
      } else if (e.key === "Enter" && actions.include.length) {
        e.preventDefault();
        addSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, removeSelection, restoreSelection, addSelection]);

  const toggleGap = useCallback(
    (gap: ViewGap) => {
      if (readOnly) return;
      apply(
        gap.removed
          ? commands.restore(gap.sectionId, [gap.range])
          : commands.remove(gap.sectionId, [gap.range], "silence"),
      );
    },
    [apply, readOnly],
  );

  const commitCorrection = useCallback(
    (word: ViewWord, text: string | null) => {
      if (text !== null) apply(commands.correctWord(word.word, text));
      setEditingPos(null);
    },
    [apply],
  );

  return (
    <div ref={wrapRef} className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-border px-1 text-xs text-muted-foreground">
        {readOnly
          ? "This clip was changed in another tab — reload to keep editing."
          : actions
            ? `${actions.wordCount} word${actions.wordCount === 1 ? "" : "s"} selected`
            : "Highlight words to remove them. Dim text is the rest of the video — click it to preview, highlight it to add it to the clip."}
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 cursor-text select-none overflow-y-auto px-1 py-3 text-[15px] leading-[2.05]"
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        onDoubleClick={onDoubleClick}
      >
        {chunks.map((chunk) => {
          const touched = !(hi < chunk.firstPos || lo > chunk.lastPos);
          return (
            <TranscriptChunk
              key={chunk.key}
              chunk={chunk}
              // Clip the selection to this chunk so untouched chunks see the
              // same props and skip re-rendering.
              selLo={touched ? Math.max(lo, chunk.firstPos) : -1}
              selHi={touched ? Math.min(hi, chunk.lastPos) : -1}
              editingPos={
                editingPos !== null && editingPos >= chunk.firstPos && editingPos <= chunk.lastPos
                  ? editingPos
                  : null
              }
              readOnly={readOnly}
              onToggleGap={toggleGap}
              onCorrect={commitCorrection}
            />
          );
        })}
      </div>

      {toolbar && actions && !readOnly && (
        <div
          role="toolbar"
          aria-label="Selected words"
          // mousedown would clear the word selection before the click lands
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            "absolute z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg",
            !toolbar.below && "-translate-y-full",
          )}
          style={{ top: toolbar.top, left: toolbar.left }}
        >
          {actions.ranges.length > 0 &&
            (actions.allRemoved ? (
              <ToolbarButton tone="neutral" onClick={restoreSelection}>
                <RotateCcwIcon className="size-3.5" /> Restore
              </ToolbarButton>
            ) : (
              <ToolbarButton tone="danger" onClick={removeSelection}>
                <ScissorsIcon className="size-3.5" /> Remove
              </ToolbarButton>
            ))}
          {actions.include.length > 0 && (
            <ToolbarButton tone="primary" onClick={addSelection}>
              <PlusIcon className="size-3.5" /> Add to clip
            </ToolbarButton>
          )}
          {(actions.startHere || actions.endHere || actions.wordCount === 1) &&
            actions.ranges.length > 0 && <span className="mx-0.5 h-5 w-px bg-border" />}
          {actions.startHere && (
            <ToolbarButton
              tone="quiet"
              onClick={() => run(commands.retime(actions.startHere!.sectionId, actions.startHere!.window))}
            >
              Start here
            </ToolbarButton>
          )}
          {actions.endHere && (
            <ToolbarButton
              tone="quiet"
              onClick={() => run(commands.retime(actions.endHere!.sectionId, actions.endHere!.window))}
            >
              End here
            </ToolbarButton>
          )}
          {actions.wordCount === 1 && view.words[lo]?.state !== "outside" && (
            <ToolbarButton
              tone="quiet"
              onClick={() => {
                setSelection(null);
                setEditingPos(lo);
              }}
            >
              Fix text
            </ToolbarButton>
          )}
        </div>
      )}
    </div>
  );
}

const TranscriptChunk = memo(function TranscriptChunk({
  chunk,
  selLo,
  selHi,
  editingPos,
  readOnly,
  onToggleGap,
  onCorrect,
}: {
  chunk: Chunk;
  selLo: number;
  selHi: number;
  editingPos: number | null;
  readOnly: boolean;
  onToggleGap: (gap: ViewGap) => void;
  onCorrect: (word: ViewWord, text: string | null) => void;
}) {
  return (
    // content-visibility needs a box, so each chunk is its own block; the
    // break falls every ~90 words, where it reads as a paragraph break.
    <p
      className="mb-2 break-words"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 190px" }}
    >
      {chunk.tokens.map((t) => {
        if (t.kind === "marker") {
          return (
            <span
              key={t.key}
              className="mr-1 inline-block rounded bg-sky-100 px-1.5 align-middle font-mono text-[10px] font-semibold leading-5 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
              title={`Part ${t.index} of the clip`}
            >
              {fmt(t.startSec)}–{fmt(t.endSec)}
            </span>
          );
        }
        if (t.kind === "gap") {
          return (
            <Fragment key={t.key}>
              <button
                type="button"
                data-gap
                disabled={readOnly}
                onClick={() => onToggleGap(t)}
                title={t.removed ? "Pause removed — click to restore" : "Click to remove this pause"}
                className={cn(
                  "mx-0.5 rounded-full border px-1.5 align-middle font-mono text-[10px] leading-4 transition-colors",
                  t.removed
                    ? "border-transparent bg-muted text-muted-foreground/60 line-through"
                    : "border-border text-muted-foreground hover:border-red-300 hover:text-red-600",
                )}
              >
                {t.durationSec.toFixed(1)}s
              </button>{" "}
            </Fragment>
          );
        }
        if (editingPos === t.pos) {
          return (
            <Fragment key={`e${t.pos}`}>
              <WordInput word={t} onDone={(text) => onCorrect(t, text)} />{" "}
            </Fragment>
          );
        }
        return (
          // The trailing real space is load-bearing: without it the browser
          // sees one unbreakable word and the transcript never wraps.
          <Fragment key={t.pos}>
            <span
              data-pos={t.pos}
              className={cn(
                "cursor-pointer rounded-sm px-px py-[3px] transition-colors data-[active=true]:bg-sky-500 data-[active=true]:text-white data-[active=preview]:bg-amber-400 data-[active=preview]:!text-black data-[active=preview]:no-underline",
                t.state === "kept" && "text-foreground hover:bg-muted",
                t.state === "outside" && "text-muted-foreground/45 hover:text-muted-foreground",
                t.state === "removed" && "line-through decoration-2",
                t.state === "removed" && t.reason === "filler" && "text-amber-600/70 decoration-amber-500/60",
                t.state === "removed" && t.reason !== "filler" && "text-red-500/60 decoration-red-400/60",
                t.corrected && "underline decoration-dotted decoration-sky-500 underline-offset-4",
                t.pos >= selLo && t.pos <= selHi && "bg-sky-200/80 !text-foreground dark:bg-sky-800/70",
              )}
            >
              {t.text}
            </span>{" "}
          </Fragment>
        );
      })}
    </p>
  );
});

function ToolbarButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone: "danger" | "primary" | "neutral" | "quiet";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-semibold transition-colors",
        tone === "danger" && "bg-red-600 text-white hover:bg-red-700",
        tone === "primary" && "bg-sky-600 text-white hover:bg-sky-700",
        tone === "neutral" && "bg-foreground text-background hover:opacity-90",
        tone === "quiet" && "px-2 font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function WordInput({
  word,
  onDone,
}: {
  word: ViewWord;
  onDone: (text: string | null) => void;
}) {
  const [value, setValue] = useState(word.text);
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(value);
        if (e.key === "Escape") onDone(null);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{ width: `${Math.max(value.length, 3) + 2}ch` }}
      className="mx-0.5 rounded border border-sky-400 bg-background px-1 text-[15px] outline-none ring-2 ring-sky-200"
    />
  );
}
