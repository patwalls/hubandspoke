"use client";

/**
 * The transcript IS the timeline: select words to cut them, click a struck
 * word to bring it back, click any word to jump there.
 *
 * Interaction is handled by event delegation on the container (words carry
 * `data-pos`), and the "now playing" highlight is applied by toggling a DOM
 * class from the engine clock — so neither a 500-word transcript nor 60fps
 * playback ever triggers a React re-render of the word list.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import { sourceToOutput } from "@/lib/clip-editor/plan";
import {
  selectionActions,
  type TranscriptView,
  type ViewGap,
  type ViewWord,
} from "@/lib/clip-editor/transcript-view";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

function fmt(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function TranscriptEditor({
  view,
  plan,
  engine,
  readOnly,
}: {
  view: TranscriptView;
  plan: RenderPlan;
  engine: PlaybackEngine;
  readOnly: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.wordSelection);
  const setSelection = useEditor((s) => s.setWordSelection);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const [editingPos, setEditingPos] = useState<number | null>(null);

  const lo = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const hi = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const actions = useMemo(
    () => (selection ? selectionActions(view, lo, hi) : null),
    [view, selection, lo, hi],
  );

  // ── "Now playing" highlight, outside React ───────────────────────────────
  // Marked with a data attribute, not a class: React owns `className` and
  // would wipe a class we added the next time selection re-renders the word.
  const viewRef = useRef(view);
  const planRef = useRef(plan);
  useEffect(() => {
    viewRef.current = view;
    planRef.current = plan;
  }, [view, plan]);
  useEffect(() => {
    let activeEl: Element | null = null;
    return engine.subscribe((snap) => {
      const seg = planRef.current.segments[snap.segmentIndex];
      let next: Element | null = null;
      if (seg && snap.sourceSec !== null) {
        const src = snap.sourceSec;
        const words = viewRef.current.words;
        // Last word of this section that has started by now.
        let hit: ViewWord | null = null;
        for (const w of words) {
          if (w.sectionId !== seg.sectionId || w.state !== "kept") continue;
          if (w.word.startSec <= src + 0.02) hit = w;
          else if (hit) break;
        }
        if (hit) {
          next =
            containerRef.current?.querySelector(`[data-pos="${hit.pos}"]`) ?? null;
        }
      }
      if (next !== activeEl) {
        activeEl?.removeAttribute("data-active");
        next?.setAttribute("data-active", "true");
        activeEl = next;
        // Follow playback, but never yank the view while the user is parked.
        if (next && snap.playing) {
          next.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    });
  }, [engine]);

  // Open with the clip's first word in view — the dimmed context before it
  // can run to a dozen lines and would otherwise be all you see.
  useEffect(() => {
    const first = viewRef.current.words.find((w) => w.state !== "outside");
    if (!first) return;
    containerRef.current
      ?.querySelector(`[data-pos="${first.pos}"]`)
      ?.scrollIntoView({ block: "start" });
    // once, on mount
  }, []);

  // ── Selection by click / shift-click / drag ─────────────────────────────
  const posFromEvent = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest("[data-pos]");
    return el ? Number(el.getAttribute("data-pos")) : null;
  };

  const seekToWord = useCallback(
    (w: ViewWord) => {
      const out = sourceToOutput(plan, w.word.startSec + 0.001, w.sectionId);
      if (out !== null) engine.seek(out);
    },
    [plan, engine],
  );

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const pos = posFromEvent(e);
    if (pos === null) {
      if (!(e.target as HTMLElement).closest("[data-gap]")) setSelection(null);
      return;
    }
    e.preventDefault(); // we draw our own selection; suppress the native one
    dragging.current = true;
    if (e.shiftKey && selection) setSelection({ anchor: selection.anchor, focus: pos });
    else setSelection({ anchor: pos, focus: pos });
    const w = view.words[pos];
    if (w && !e.shiftKey) seekToWord(w);
  };

  const onMouseOver = (e: MouseEvent) => {
    if (!dragging.current || !selection) return;
    const pos = posFromEvent(e);
    if (pos !== null && pos !== selection.focus) {
      setSelection({ anchor: selection.anchor, focus: pos });
    }
  };

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onDoubleClick = (e: MouseEvent) => {
    if (readOnly) return;
    const pos = posFromEvent(e);
    if (pos !== null && view.words[pos]?.state !== "outside") setEditingPos(pos);
  };

  // ── Actions ─────────────────────────────────────────────────────────────
  const removeSelection = useCallback(() => {
    if (!actions || readOnly) return;
    apply((doc) =>
      actions.ranges.reduce(
        (d, r) => commands.remove(r.sectionId, [r.range], "manual")(d),
        doc,
      ),
    );
    setSelection(null);
  }, [actions, apply, readOnly, setSelection]);

  const restoreSelection = useCallback(() => {
    if (!actions || readOnly) return;
    apply((doc) =>
      actions.ranges.reduce((d, r) => commands.restore(r.sectionId, [r.range])(d), doc),
    );
    setSelection(null);
  }, [actions, apply, readOnly, setSelection]);

  // Delete / Backspace on the selection. Registered here (not on the dialog)
  // because only this component knows what the selection means.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if ((e.key === "Backspace" || e.key === "Delete") && actions?.ranges.length) {
        e.preventDefault();
        if (actions.allRemoved) restoreSelection();
        else removeSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, removeSelection, restoreSelection]);

  const toggleGap = (gap: ViewGap) => {
    if (readOnly) return;
    apply(
      gap.removed
        ? commands.restore(gap.sectionId, [gap.range])
        : commands.remove(gap.sectionId, [gap.range], "silence"),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Selection bar — fixed slot so the transcript never jumps. */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-1 text-xs">
        {actions && !readOnly ? (
          <>
            <span className="mr-1 text-muted-foreground">
              {actions.wordCount} word{actions.wordCount === 1 ? "" : "s"}
            </span>
            {actions.ranges.length > 0 &&
              (actions.allRemoved ? (
                <BarButton onClick={restoreSelection}>Restore</BarButton>
              ) : (
                <BarButton onClick={removeSelection} tone="danger">
                  Remove <Kbd>⌫</Kbd>
                </BarButton>
              ))}
            {actions.extend && (
              <BarButton
                onClick={() => {
                  apply(commands.retime(actions.extend!.sectionId, actions.extend!.window));
                  setSelection(null);
                }}
              >
                Extend clip to here
              </BarButton>
            )}
            {actions.startHere && (
              <BarButton
                onClick={() => {
                  apply(commands.retime(actions.startHere!.sectionId, actions.startHere!.window));
                  setSelection(null);
                }}
              >
                Start clip here
              </BarButton>
            )}
            {actions.endHere && (
              <BarButton
                onClick={() => {
                  apply(commands.retime(actions.endHere!.sectionId, actions.endHere!.window));
                  setSelection(null);
                }}
              >
                End clip here
              </BarButton>
            )}
            {actions.wordCount === 1 && view.words[lo]?.state !== "outside" && (
              <BarButton onClick={() => setEditingPos(lo)}>Correct text</BarButton>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">
            {readOnly
              ? "This clip was changed in another tab — reload to keep editing."
              : "Select words to cut them · click a struck word to restore · double-click to fix a typo"}
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 cursor-text select-none overflow-y-auto px-1 py-3 text-[15px] leading-[2.05]"
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        onDoubleClick={onDoubleClick}
      >
        {view.sections.map(({ section, tokens }) => (
          <div key={section.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5",
                  section.role === "intro"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                    : "bg-muted",
                )}
              >
                {section.role === "intro" ? "Intro" : "Clip"}
              </span>
              <span className="font-mono font-normal normal-case">
                {fmt(section.startSec)}–{fmt(section.endSec)}
              </span>
            </div>
            {/* Tokens are separated by real spaces (the trailing " " in each
                fragment) — without them the browser sees one unbreakable
                word and the transcript never wraps. */}
            <p className="break-words">
              {tokens.map((t) => (
                <Fragment key={t.kind === "gap" ? t.key : `w${t.pos}`}>
                  {renderToken(t)}{" "}
                </Fragment>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );

  function renderToken(t: ViewWord | ViewGap) {
    return (
                t.kind === "gap" ? (
                  <button
                    key={t.key}
                    type="button"
                    data-gap
                    disabled={readOnly}
                    onClick={() => toggleGap(t)}
                    title={t.removed ? "Pause removed — click to restore" : "Click to remove this pause"}
                    className={cn(
                      "mx-0.5 rounded-full border px-1.5 align-middle font-mono text-[10px] leading-4 transition-colors",
                      t.removed
                        ? "border-transparent bg-muted text-muted-foreground/60 line-through"
                        : "border-border text-muted-foreground hover:border-red-300 hover:text-red-600",
                    )}
                  >
                    {t.durationSec.toFixed(1)}s
                  </button>
                ) : editingPos === t.pos ? (
                  <WordInput
                    key={`edit-${t.pos}`}
                    word={t}
                    onDone={(text) => {
                      if (text !== null) apply(commands.correctWord(t.word, text));
                      setEditingPos(null);
                    }}
                  />
                ) : (
                  <span
                    key={t.pos}
                    data-pos={t.pos}
                    className={cn(
                      "cursor-pointer rounded-sm px-px py-[3px] transition-colors data-[active=true]:bg-sky-500 data-[active=true]:text-white",
                      t.state === "kept" && "text-foreground hover:bg-muted",
                      t.state === "outside" && "text-muted-foreground/45 hover:text-muted-foreground",
                      t.state === "removed" && "line-through decoration-2",
                      t.state === "removed" && t.reason === "filler" && "text-amber-600/70 decoration-amber-500/60",
                      t.state === "removed" && t.reason !== "filler" && "text-red-500/60 decoration-red-400/60",
                      t.corrected && "underline decoration-dotted decoration-sky-500 underline-offset-4",
                      t.pos >= lo && t.pos <= hi && "bg-sky-200/70 dark:bg-sky-800/60",
                    )}
                  >
                    {t.text}
                  </span>
                )
    );
  }
}

function BarButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      // mousedown would clear the word selection before the click lands
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 font-medium transition-colors hover:bg-muted",
        tone === "danger" && "border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
      )}
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-current/20 px-1 font-sans text-[10px] opacity-70">
      {children}
    </kbd>
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
