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
 * ⌘C / ⌘X copy or cut the highlighted words WITH their footage; ⌘V plays
 * that footage again where the cursor is (Descript). A copy is its own scene
 * — its words read again where it plays, and editing them leaves the
 * original alone. Cut = copy, then strike the original.
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
import { CheckIcon, ChevronsLeftRightIcon, CopyIcon, PlusIcon, RotateCcwIcon, ScissorsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSourceSection, type ClipEditDoc } from "@/lib/clip-editor/doc";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import { sourceToOutput } from "@/lib/clip-editor/plan";
import {
  selectionActions,
  selectionText,
  type TranscriptView,
  type ViewGap,
  type ViewToken,
  type ViewWord,
} from "@/lib/clip-editor/transcript-view";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";
import { copyPieces, type ClipPiece } from "@/lib/clip-editor/sections";
import { countMatches } from "@/lib/clip-editor/word-correct";
import { toast } from "sonner";
import { applyWordTrim, stepWordTrim, wordTrimAudition, wordTrimWindow } from "@/lib/clip-editor/word-trim";
import { WordTrimmer } from "./word-trimmer";

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
    lastPos = -1;
    count = 0;
  };
  for (const t of tokens) {
    // Never start a chunk with a pause chip — keep it with the word before.
    if (count >= WORDS_PER_CHUNK && t.kind !== "gap") flush();
    current.push(t);
    if (t.kind === "word") {
      // A scene moved out of recorded order shows away from its neighbours,
      // so a chunk's positions are a span (min…max), not first…last.
      firstPos = firstPos < 0 ? t.pos : Math.min(firstPos, t.pos);
      lastPos = Math.max(lastPos, t.pos);
      count++;
    }
  }
  flush();
  return chunks;
}

/** id → { label, colour class } for the inline speaker names. */
export type SpeakerLabels = Record<string, { label: string; className: string }>;

export function TranscriptEditor({
  view,
  doc,
  plan,
  engine,
  speakers,
  readOnly,
}: {
  view: TranscriptView;
  speakers: SpeakerLabels;
  doc: ClipEditDoc;
  plan: RenderPlan;
  engine: PlaybackEngine;
  readOnly: boolean;
}) {
  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.wordSelection);
  const setSelection = useEditor((s) => s.setWordSelection);
  const stageSelection = useEditor((s) => s.stageSelection);
  /** A scene picked on the timeline: its text is highlighted (Descript's
   *  lavender) and scrolled into view. */
  const sceneSelection = useEditor((s) => s.sceneSelection);
  const setStageSelection = useEditor((s) => s.setStageSelection);
  /** The text cursor (Descript-style): it sits AFTER the word at this
   *  position (-1 = before the first word). ← / → move it a word at a time. */
  const [caret, setCaret] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  /** A mousedown on a not-in-edit word that may still turn into a drag. */
  const clickRef = useRef<{ pos: number; sourceSec: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editingPos, setEditingPos] = useState<number | null>(null);
  const [toolbar, setToolbar] = useState<{ top: number; left: number; below: boolean } | null>(null);
  /** The word whose trim popover is open (double-click), and where it sits. */
  const [trimPos, setTrimPos] = useState<number | null>(null);
  const [trimBox, setTrimBox] = useState<{ top: number; left: number } | null>(null);
  /** A join to play once the plan has caught up with the last trim. */
  const [audition, setAudition] = useState<{ sectionId: string; startSec: number; endSec: number; key: number } | null>(null);

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
  // Preview plays the source only, so only its words can light up there.
  const sourceWords = useMemo(() => view.words.filter((w) => !w.word.mediaId), [view]);
  const liveRef = useRef({ keptBySection, plan, words: sourceWords });
  useEffect(() => {
    liveRef.current = { keptBySection, plan, words: sourceWords };
  }, [keptBySection, plan, sourceWords]);

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
    const longest = doc.sections.filter(isSourceSection).sort(
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

  /** Keep a highlight inside one block: a scene moved out of order shows
   *  apart from the words around it in the recording. */
  const clampFocus = useCallback(
    (anchor: number, focus: number) => {
      const block = view.words[anchor]?.block;
      if (!block || view.words[focus]?.block === block) return focus;
      const step = focus > anchor ? 1 : -1;
      let p = anchor;
      while (view.words[p + step]?.block === block && p !== focus) p += step;
      return p;
    },
    [view],
  );

  // ── Selection by click / shift-click / drag ─────────────────────────────
  // Google-Docs forgiving: a press anywhere in the text — the gap between
  // words, past the end of a line, the margin — lands on the nearest word.
  // A click only parks the cursor; a drag of a few pixels highlights.
  const posFromEvent = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest("[data-pos]");
    return el ? Number(el.getAttribute("data-pos")) : null;
  };

  /** The word nearest a point: probe sideways along the line (left first,
   *  so the end of a line finds its last word), then just above / below. */
  const wordAtPoint = useCallback((x: number, y: number): { pos: number; box: DOMRect } | null => {
    const root = scrollRef.current;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const cx = Math.min(Math.max(x, r.left + 1), r.right - 1);
    const cy = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
    const hit = (px: number, py: number) => {
      const el = document.elementFromPoint(px, py)?.closest<HTMLElement>("[data-pos]");
      return el && root.contains(el) ? el : null;
    };
    for (const dy of [0, -6, 6, -12, 12]) {
      for (let dx = 0; dx <= r.width; dx += 8) {
        const el = hit(cx - dx, cy + dy) ?? (dx > 0 ? hit(cx + dx, cy + dy) : null);
        if (el) return { pos: Number(el.dataset.pos), box: el.getBoundingClientRect() };
      }
    }
    return null;
  }, []);

  /** "Before this word" = after the word shown just before it (a moved
   *  scene's first word follows whatever precedes it on screen). */
  const shownBefore = useCallback(
    (pos: number) => {
      const i = view.displayOrder.indexOf(pos);
      return i > 0 ? view.displayOrder[i - 1] : -1;
    },
    [view],
  );
  const shownAfter = useCallback(
    (caretPos: number) => {
      const order = view.displayOrder;
      const i = caretPos < 0 ? -1 : order.indexOf(caretPos);
      return order[Math.min(i + 1, order.length - 1)];
    },
    [view],
  );

  /** A press that hasn't moved far enough to be a drag yet. */
  const pressRef = useRef<{ x: number; y: number; caret: number; extend: boolean } | null>(null);

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (trimPos !== null) setTrimPos(null); // any click in the text closes the trimmer
    if ((e.target as HTMLElement).closest("[data-gap]")) return; // pause chips toggle themselves
    const near = wordAtPoint(e.clientX, e.clientY);
    if (!near) {
      setSelection(null);
      return;
    }
    e.preventDefault(); // we draw our own highlight; suppress the native one
    draggingRef.current = true;
    setDragging(true);
    // The transcript takes the arrow keys back from the preview.
    if (stageSelection) setStageSelection(null);
    const { pos, box } = near;
    if (e.shiftKey) {
      // Extend from the highlight (or from the cursor) to here.
      const anchor = selection?.anchor ?? (caret !== null ? shownAfter(caret) : pos);
      setSelection({ anchor, focus: clampFocus(anchor, pos) });
      setCaret(pos);
      pressRef.current = null;
      clickRef.current = null;
      return;
    }
    // Park the cursor on the nearer side of the word.
    const at = e.clientX < box.left + box.width / 2 ? shownBefore(pos) : pos;
    setCaret(at);
    setSelection(null);
    pressRef.current = { x: e.clientX, y: e.clientY, caret: at, extend: false };
    clickRef.current = null;
    // Only a press right on a word plays / auditions it.
    if (posFromEvent(e) !== pos) return;
    const w = view.words[pos];
    if (!w) return;
    if (w.state === "kept" || w.word.mediaId) {
      // A cut word of an uploaded clip can't be auditioned (preview plays
      // the source) — go to where its scene resumes instead.
      const out = sourceToOutput(plan, w.word.startSec + 0.001, w.sectionId ?? undefined);
      if (out !== null) engine.seek(out);
    } else {
      // Not in the edit (rest of the video, or a cut word): audition it. But
      // only on a plain CLICK — decided at mouseup — so dragging a highlight
      // across dim words to add them doesn't start the video blaring.
      clickRef.current = { pos, sourceSec: w.word.startSec };
    }
  };

  // While the button is down, the highlight follows the pointer wherever it
  // goes — gaps, margins, outside the panel — and the text scrolls when it
  // nears the top or bottom edge.
  useEffect(() => {
    if (!dragging) return;
    let last: { x: number; y: number } | null = null;
    let frame = 0;
    const DRAG_START_PX = 4;
    const EDGE_PX = 36;
    const extendTo = (x: number, y: number) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.extend) {
        if (Math.hypot(x - press.x, y - press.y) < DRAG_START_PX) return;
        press.extend = true;
        clickRef.current = null; // it became a drag
      }
      const near = wordAtPoint(x, y);
      if (!near) return;
      const order = view.displayOrder;
      const idx = (p: number) => (p < 0 ? -1 : order.indexOf(p));
      // The highlight grows from the cursor: forward from the word after
      // it, backward from the word before it.
      const after = shownAfter(press.caret);
      const forward = idx(near.pos) >= idx(after);
      const anchor = forward || press.caret < 0 ? after : press.caret;
      setSelection({ anchor, focus: clampFocus(anchor, near.pos) });
      setCaret(forward ? near.pos : shownBefore(near.pos));
    };
    const tick = () => {
      const root = scrollRef.current;
      if (last && root) {
        const r = root.getBoundingClientRect();
        const dy = last.y < r.top + EDGE_PX ? last.y - (r.top + EDGE_PX) : last.y > r.bottom - EDGE_PX ? last.y - (r.bottom - EDGE_PX) : 0;
        if (dy !== 0 && pressRef.current?.extend) {
          root.scrollTop += Math.max(-24, Math.min(24, dy / 2));
          extendTo(last.x, last.y);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (ev: globalThis.MouseEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      extendTo(ev.clientX, ev.clientY);
    };
    window.addEventListener("mousemove", move);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("mousemove", move);
      cancelAnimationFrame(frame);
    };
  }, [dragging, view, wordAtPoint, shownAfter, shownBefore, clampFocus, setSelection]);

  useEffect(() => {
    const up = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      pressRef.current = null;
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
    const w = pos !== null ? view.words[pos] : undefined;
    if (!w || w.state === "outside") return;
    setSelection(null);
    // A kept word opens the trimmer (which has the spelling field too); a
    // cut word only has its text to fix.
    if (w.state === "kept") setTrimPos(pos);
    else setEditingPos(pos);
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

  // The trim popover sits under its word and follows scrolling; it closes
  // when the word scrolls out of view or is no longer kept.
  const placeTrimmer = useCallback(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller || trimPos === null) return setTrimBox(null);
    const el = scroller.querySelector(`[data-pos="${trimPos}"]`);
    if (!el) return setTrimBox(null);
    const word = el.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    if (word.bottom < port.top || word.top > port.bottom) return setTrimBox(null);
    setTrimBox({ top: word.bottom + 6 - box.top, left: Math.min(Math.max(word.left + word.width / 2 - box.left, 185), box.width - 185) });
  }, [trimPos]);
  useLayoutEffect(placeTrimmer, [placeTrimmer, view]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.addEventListener("scroll", placeTrimmer, { passive: true });
    window.addEventListener("resize", placeTrimmer);
    return () => {
      scroller.removeEventListener("scroll", placeTrimmer);
      window.removeEventListener("resize", placeTrimmer);
    };
  }, [placeTrimmer]);
  useEffect(() => {
    if (trimPos !== null && view.words[trimPos]?.state !== "kept") setTrimPos(null);
  }, [trimPos, view]);

  /** The trim window of a kept word, computed from the live doc. */
  const trimWindowFor = useCallback(
    (pos: number) => {
      const w = view.words[pos];
      if (!w || w.state !== "kept" || !w.sectionId) return null;
      const section = doc.sections.find((s) => s.id === w.sectionId);
      if (!section) return null;
      return wordTrimWindow(section, view.words.map((v) => v.word), pos, (i) => view.words[i].text);
    },
    [view, doc],
  );

  /** Write new cut points for a word and queue the join for playback. */
  const trimWord = useCallback(
    (pos: number, inSec: number, outSec: number, coalesceKey?: string) => {
      const win = trimWindowFor(pos);
      if (!win || readOnly) return;
      apply((d) => ({ ...d, sections: d.sections.map((s) => (s.id === win.sectionId ? applyWordTrim(s, win, inSec, outSec) : s)) }), coalesceKey);
      const range = wordTrimAudition(win, inSec, outSec);
      setAudition({ sectionId: win.sectionId, ...range, key: Date.now() });
    },
    [trimWindowFor, apply, readOnly],
  );

  // Play the join once the plan reflects the trim (it is recomputed by the
  // parent after `apply`, a render later). Each audition plays once: the plan
  // also changes on unrelated edits (typing the hook), which must not replay it.
  const playedAuditionKey = useRef<number | null>(null);
  const auditionStopTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!audition || playedAuditionKey.current === audition.key) return;
    const start = sourceToOutput(plan, audition.startSec, audition.sectionId) ?? sourceToOutput(plan, audition.startSec + 0.75, audition.sectionId);
    const end = sourceToOutput(plan, audition.endSec, audition.sectionId);
    if (start === null) return;
    playedAuditionKey.current = audition.key;
    engine.seek(start);
    engine.play();
    const ms = Math.max(400, ((end ?? start + 1.2) - start) * 1000);
    window.clearTimeout(auditionStopTimer.current);
    auditionStopTimer.current = window.setTimeout(() => engine.pause(), ms);
  }, [audition, plan, engine]);
  useEffect(() => () => window.clearTimeout(auditionStopTimer.current), []);

  // ── Actions ─────────────────────────────────────────────────────────────
  const run = useCallback(
    (mutate: (d: ClipEditDoc) => ClipEditDoc) => {
      if (readOnly) return;
      apply(mutate);
      setSelection(null);
    },
    [apply, readOnly, setSelection],
  );

  /**
   * Tidy one edge of a single kept word from the toolbar: the first press
   * cuts the gap beside it (where the blip usually lives), later presses
   * shave the word, and each plays the join. The popover does the same
   * with handles — see word-trim.ts.
   */
  const trimWordEdge = useCallback(
    (edge: "start" | "end") => {
      if (!selection || readOnly) return;
      const lo = Math.min(selection.anchor, selection.focus);
      const win = trimWindowFor(lo);
      if (!win) return;
      const next = stepWordTrim(win, edge);
      if (next) trimWord(lo, next.inSec, next.outSec, `trim-${lo}-${edge}`);
    },
    [selection, readOnly, trimWindowFor, trimWord],
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

  // The highlight is ours, not the browser's, so ⌘C needs wiring by hand.
  // The text goes to the system clipboard; the footage under it to ours,
  // for ⌘V.
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [lo, hi]);
  const clipboardRef = useRef<ClipPiece[]>([]);
  const copySelection = useCallback(() => {
    if (lo < 0) return;
    if (actions?.ranges.length) clipboardRef.current = copyPieces(doc, actions.ranges);
    void navigator.clipboard.writeText(selectionText(view, lo, hi)).then(() => setCopied(true));
  }, [view, doc, actions, lo, hi]);

  const cutSelection = useCallback(() => {
    if (!actions?.ranges.length || readOnly) return;
    copySelection();
    if (!actions.allRemoved) removeSelection();
  }, [actions, readOnly, copySelection, removeSelection]);

  /** ⌫ / Delete with just the cursor (no highlight): strike the word
   *  before / after it, like a doc. Backspace then steps the cursor back,
   *  so holding it eats words one by one; an already-struck word is just
   *  stepped over. */
  const deleteAtCursor = useCallback(
    (dir: "back" | "forward") => {
      if (caret === null || readOnly) return false;
      const pos = dir === "back" ? caret : shownAfter(caret);
      // (shownAfter stays on the last word at the end of the text)
      if (pos === undefined || pos < 0 || (dir === "forward" && pos === caret)) return false;
      const w = view.words[pos];
      if (!w?.sectionId) return false; // outside the clip: nothing to cut
      if (w.state === "kept") {
        const { ranges } = selectionActions(view, doc, pos, pos);
        apply((d) => ranges.reduce((acc, r) => commands.remove(r.sectionId, [r.range], "manual")(acc), d));
      }
      if (dir === "back") setCaret(shownBefore(pos));
      else setCaret(pos);
      return true;
    },
    [caret, readOnly, view, doc, apply, shownAfter, shownBefore],
  );

  /** ⌘V: where the cursor sits decides the spot — between two words of one
   *  scene splits it there; at a scene's edge goes before / after it. */
  const pasteAtCursor = useCallback(() => {
    const pieces = clipboardRef.current;
    if (!pieces.length || readOnly) return false;
    const ref = caret ?? (selection ? hi : null);
    if (ref === null) return false;
    const order = view.displayOrder;
    const i = ref < 0 ? -1 : order.indexOf(ref);
    const before = i >= 0 ? view.words[order[i]] : undefined;
    const after = i + 1 < order.length ? view.words[order[i + 1]] : undefined;
    const at =
      before?.sectionId && after?.sectionId === before.sectionId
        ? { sectionId: before.sectionId, atSec: after.word.startSec }
        : before?.sectionId
          ? { sectionId: before.sectionId, atSec: Number.POSITIVE_INFINITY }
          : after?.sectionId
            ? { sectionId: after.sectionId, atSec: Number.NEGATIVE_INFINITY }
            : null;
    if (!at) {
      toast.error("Put the cursor inside the clip to paste");
      return true;
    }
    if (commands.paste(pieces, at)(doc) === doc) {
      toast.error("A clip can have up to 20 scenes — delete one to paste");
      return true;
    }
    run(commands.paste(pieces, at));
    return true;
  }, [caret, selection, hi, view, doc, readOnly, run]);

  // Where the highlight plays: the timeline shades it, and once the
  // highlight settles (mouse up, or each ⇧-arrow step) the playhead jumps to
  // its start — Descript-style.
  const setHighlightOut = useEditor((s) => s.setHighlightOut);
  const highlightOut = useMemo(() => {
    if (lo < 0) return null;
    let startSec = Number.POSITIVE_INFINITY;
    let endSec = Number.NEGATIVE_INFINITY;
    for (let p = lo; p <= hi; p++) {
      const w = view.words[p];
      if (w?.state !== "kept" || !w.sectionId) continue;
      const a = sourceToOutput(plan, w.word.startSec + 0.001, w.sectionId);
      const b = sourceToOutput(plan, Math.max(w.word.startSec + 0.001, w.word.endSec - 0.001), w.sectionId);
      if (a !== null) startSec = Math.min(startSec, a);
      if (b !== null) endSec = Math.max(endSec, b);
    }
    return endSec > startSec ? { startSec, endSec } : null;
  }, [view, plan, lo, hi]);
  useEffect(() => setHighlightOut(highlightOut), [highlightOut, setHighlightOut]);
  useEffect(() => () => setHighlightOut(null), [setHighlightOut]);
  const seekedFor = useRef<string | null>(null);
  useEffect(() => {
    if (dragging || !highlightOut) {
      if (lo < 0) seekedFor.current = null;
      return;
    }
    // Once per highlight — not again on every edit that re-derives the plan.
    const key = `${lo}:${hi}`;
    if (seekedFor.current === key) return;
    seekedFor.current = key;
    engine.seek(highlightOut.startSec);
  }, [dragging, highlightOut, lo, hi, engine]);

  // Picking a scene on the timeline scrolls the transcript to its first word.
  useEffect(() => {
    if (!sceneSelection) return;
    const first = view.displayOrder.find((p) => view.words[p]?.sectionId === sceneSelection);
    if (first === undefined) return;
    scrollRef.current?.querySelector(`[data-pos="${first}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    // only when the pick changes, not on every edit of the doc
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneSelection]);

  // ← / → move the cursor word by word (Descript-style), the playhead
  // following it through the clip; ⇧ extends the highlight a word at a time.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable) return;
      if (stageSelection || e.metaKey || e.ctrlKey || e.altKey) return;
      if (caret === null && !selection) return;
      e.preventDefault();
      // Walk words in DISPLAY order (a moved scene reads where it plays).
      const order = view.displayOrder;
      const n = order.length;
      const idxOf = new Map(order.map((p, i) => [p, i]));
      const at = (i: number) => (i < 0 ? -1 : order[Math.min(i, n - 1)]);
      const ix = (p: number | null) => (p === null || p < 0 ? -1 : (idxOf.get(p) ?? -1));
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const clampI = (i: number) => Math.max(0, Math.min(n - 1, i));
      const lo = selection ? Math.min(ix(selection.anchor), ix(selection.focus)) : null;
      const hi = selection ? Math.max(ix(selection.anchor), ix(selection.focus)) : null;
      let next: number;
      if (e.shiftKey) {
        if (selection) {
          // Grow / shrink the highlight from its moving end (within its block).
          const focus = clampFocus(selection.anchor, at(clampI(ix(selection.focus) + dir)));
          setSelection({ anchor: selection.anchor, focus });
          next = dir > 0 ? focus : at(ix(focus) - 1);
        } else {
          // Start a highlight at the word on that side of the cursor.
          const w = at(clampI(dir > 0 ? ix(caret) + 1 : ix(caret)));
          setSelection({ anchor: w, focus: w });
          next = dir > 0 ? w : at(ix(w) - 1);
        }
      } else if (selection && (lo !== hi || caret === null)) {
        // A highlight collapses to its edge, like any text editor.
        next = dir > 0 ? at(hi!) : at(lo! - 1);
        setSelection(null);
      } else {
        next = at(Math.max(-1, Math.min(n - 1, ix(caret) + dir)));
        if (selection) setSelection(null);
      }
      setCaret(next);
      // The playhead follows: to the start of the word right after the cursor.
      const after = ix(next) + 1;
      const w = view.words[after < n ? order[after] : order[n - 1]];
      if (w?.state === "kept") {
        const out = sourceToOutput(plan, (after < n ? w.word.startSec : w.word.endSec) + 0.001, w.sectionId ?? undefined);
        if (out !== null) engine.seek(out);
      }
      scrollRef.current?.querySelector(`[data-pos="${Math.max(0, next)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    // Capture phase: something inside the dialog stops arrow keys before
    // they bubble back up to the window (the timeline's keys work the same).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [caret, selection, stageSelection, view, plan, engine, setSelection, clampFocus]);

  // ⌫ / Delete removes (or restores); Enter adds dim words to the clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === "v" && pasteAtCursor()) {
        e.preventDefault();
        return;
      }
      if (!actions) {
        if ((e.key === "Backspace" || e.key === "Delete") && !cmd && deleteAtCursor(e.key === "Backspace" ? "back" : "forward")) e.preventDefault();
        return;
      }
      if (cmd && e.key === "c" && !window.getSelection()?.toString()) {
        e.preventDefault();
        copySelection();
      } else if (cmd && e.key === "x" && actions.ranges.length) {
        e.preventDefault();
        cutSelection();
      } else if ((e.key === "Backspace" || e.key === "Delete") && actions.ranges.length) {
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
  }, [actions, removeSelection, restoreSelection, addSelection, copySelection, cutSelection, pasteAtCursor, deleteAtCursor]);

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
              caretAfter={caret !== null && (caret === -1 || (caret >= chunk.firstPos && caret <= chunk.lastPos)) ? caret : null}
              firstShownPos={view.displayOrder[0] ?? 0}
              sceneHighlight={sceneSelection}
              readOnly={readOnly}
              speakers={speakers}
              onToggleGap={toggleGap}
              onCorrect={commitCorrection}
            />
          );
        })}
      </div>

      {trimPos !== null && trimBox && !readOnly && (() => {
        const win = trimWindowFor(trimPos);
        const w = view.words[trimPos];
        if (!win || !w) return null;
        return (
          <div className="absolute z-20 -translate-x-1/2" style={{ top: trimBox.top, left: trimBox.left }}>
            <WordTrimmer
              win={win}
              text={w.text}
              onTrim={(inSec, outSec) => trimWord(trimPos, inSec, outSec)}
              onText={(text) => apply(commands.correctWord(w.word, text))}
              onTextAll={(text) => apply(commands.correctAllWords(view.words, w, text))}
              matchCount={countMatches(view.words, w.text)}
              onAudition={() => setAudition({ sectionId: win.sectionId, ...wordTrimAudition(win, win.inSec, win.outSec), key: Date.now() })}
              onClose={() => setTrimPos(null)}
            />
          </div>
        );
      })()}

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
          {actions.wordCount === 1 && view.words[lo]?.state === "kept" && (
            <span className="flex items-center gap-0.5" title="Tidy a blip at the edge of this word: the first press cuts the gap beside it, then each press shaves 0.08s, and the join plays. Double-click the word for handles. Undo with ⌘Z.">
              <ChevronsLeftRightIcon className="mx-0.5 size-3.5 text-muted-foreground" />
              <ToolbarButton tone="quiet" onClick={() => trimWordEdge("start")}>
                ◁ start
              </ToolbarButton>
              <ToolbarButton tone="quiet" onClick={() => trimWordEdge("end")}>
                end ▷
              </ToolbarButton>
              <ToolbarButton tone="quiet" onClick={() => { setSelection(null); setTrimPos(lo); }}>
                Fine-tune…
              </ToolbarButton>
            </span>
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
          <ToolbarButton tone="quiet" onClick={copySelection}>
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </ToolbarButton>
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
  caretAfter,
  firstShownPos,
  sceneHighlight,
  readOnly,
  speakers,
  onToggleGap,
  onCorrect,
}: {
  chunk: Chunk;
  speakers: SpeakerLabels;
  selLo: number;
  selHi: number;
  editingPos: number | null;
  /** The cursor sits after the word at this position (-1 = before the
   *  first word); null when it isn't in this chunk. */
  caretAfter: number | null;
  /** The first word on screen (where a cursor at -1 is drawn). */
  firstShownPos: number;
  /** The scene picked on the timeline — its words get a lavender wash. */
  sceneHighlight: string | null;
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
        if (t.kind === "speaker") {
          const sp = speakers[t.speakerId];
          if (!sp) return null;
          return (
            <span
              key={t.key}
              className={cn(
                "mr-1 select-none align-baseline text-[11px] font-bold uppercase tracking-wide",
                sp.className,
              )}
            >
              {sp.label}:
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
            {caretAfter === -1 && t.pos === firstShownPos && <span aria-hidden className="relative inline-block h-[1.15em] w-0.5 translate-y-[0.2em] animate-pulse bg-foreground" />}
            <span
              data-pos={t.pos}
              className={cn(
                "cursor-pointer rounded-sm px-px py-[3px] transition-colors data-[active=true]:bg-sky-500 data-[active=true]:text-white data-[active=preview]:bg-amber-400 data-[active=preview]:!text-black data-[active=preview]:no-underline",
                t.state === "kept" && "text-foreground hover:bg-muted",
                t.state === "outside" && "text-muted-foreground/45 hover:text-muted-foreground",
                t.state === "removed" && "line-through decoration-2",
                t.state === "removed" && t.reason === "filler" && "text-amber-600/70 decoration-amber-500/60",
                t.state === "removed" && t.reason !== "filler" && "text-red-500/60 decoration-red-400/60",
                t.state === "kept" && t.trimStartSec > 0 && "border-l-2 border-rose-400/80",
                t.state === "kept" && t.trimEndSec > 0 && "border-r-2 border-rose-400/80",
                t.corrected && "underline decoration-dotted decoration-sky-500 underline-offset-4",
                t.pos >= selLo && t.pos <= selHi
                  ? "bg-sky-200/80 !text-foreground dark:bg-sky-800/70"
                  : sceneHighlight !== null && t.sectionId === sceneHighlight && "rounded-none bg-violet-200/60 dark:bg-violet-900/40",
              )}
            >
              {t.text}
            </span>
            {caretAfter === t.pos && <span aria-hidden className="relative -ml-px inline-block h-[1.15em] w-0.5 translate-y-[0.2em] animate-pulse bg-foreground" />}
            {/* The space too, so a picked scene reads as one continuous band. */}
            {sceneHighlight !== null && t.sectionId === sceneHighlight ? <span className="bg-violet-200/60 py-[3px] dark:bg-violet-900/40"> </span> : " "}
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
