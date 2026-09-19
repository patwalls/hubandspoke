"use client";

/**
 * Draws one page at its true canvas size inside a CSS-scaled box — the same
 * trick as the clip editor's stage, and the same contract: every element is
 * drawn from the same layout the exporter uses (render-tree.ts mirrors this
 * markup node for node), so what you drag is what gets rendered.
 *
 * `interactive` adds selection, drag-to-move, resize handles and inline text
 * editing. Without it the same component is the page thumbnail.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/lib/utils";
import { FONTS, fontFaceCss } from "@/lib/clip-editor/fonts";
import type { EditorWord } from "@/lib/clip-editor/words";
import type { DesignCaptionsElement, DesignDoc, DesignElement, DesignImageElement, DesignPage, DesignSpan, DesignTextElement, DesignVideoElement, Rgba } from "@/lib/design-editor/doc";
import { pageVideo } from "@/lib/design-editor/doc";
import { activeCue, buildDesignCaptionCues, layoutCaptionCue } from "@/lib/design-editor/captions";
import { coverGeometry, cropForOffset, layoutDesignText } from "@/lib/design-editor/layout";
import { commands, useDesign } from "./store";

/**
 * Playback of the page's clip, shared by the <video> (which owns the clock)
 * and the captions (which read it). Time is CLIP seconds. Thumbnails run on
 * the inert default.
 */
export interface PlaybackState {
  timeSec: number;
  playing: boolean;
  /** Length of the source video, once its metadata loaded (0 = unknown). */
  durationSec: number;
  setTime: (sec: number) => void;
  setPlaying: (on: boolean) => void;
  setDuration: (sec: number) => void;
  /** Reload the <video> at this clip time (after a trim edit / scrub). */
  seekRequest: { sec: number; nonce: number } | null;
}
export const PlaybackContext = createContext<PlaybackState>({ timeSec: 0, playing: false, durationSec: 0, setTime: () => {}, setPlaying: () => {}, setDuration: () => {}, seekRequest: null });

function rgba(c: Rgba): string {
  const r = parseInt(c.color.slice(1, 3), 16);
  const g = parseInt(c.color.slice(3, 5), 16);
  const b = parseInt(c.color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${c.alpha})`;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

export function PageCanvas({
  doc,
  page,
  pageIndex,
  imageUrls,
  videoUrl,
  words,
  scale,
  interactive,
  showSlots = false,
  className,
}: {
  doc: DesignDoc;
  page: DesignPage;
  pageIndex: number;
  imageUrls: Record<string, string>;
  /** Browser-loadable URL of the source video (video slides). */
  videoUrl: string | null;
  /** Source transcript words (captions on video slides). */
  words: EditorWord[];
  scale: number;
  interactive: boolean;
  /** Template mode: label every slot on the page. */
  showSlots?: boolean;
  className?: string;
}) {
  const { width: W, height: H } = doc.canvas;
  const selection = useDesign((s) => s.selection);
  const editingId = useDesign((s) => s.editingElementId);
  const select = useDesign((s) => s.select);
  const setEditing = useDesign((s) => s.setEditing);
  const apply = useDesign((s) => s.apply);
  const selectedId = interactive && selection.pageIndex === pageIndex ? selection.elementId : null;
  /** Pixel size of each picture/clip once loaded — the crop needs it. */
  const naturalSizes = useRef<Record<string, { width: number; height: number }>>({});
  const video = pageVideo(page);
  /** Repositioning a picture/clip: everything else on the page goes inert
   *  so a drag anywhere over it pans the picture, not the text on top. */
  const adjustingId = interactive && editingId
    ? (page.elements.find((el) => el.id === editingId && (el.type === "image" || el.type === "video"))?.id ?? null)
    : null;
  const cues = useMemo(() => {
    const cap = page.elements.find((el) => el.type === "captions");
    return video && cap && cap.type === "captions" ? buildDesignCaptionCues(words, video, cap.maxWordsPerCue) : [];
  }, [page.elements, video, words]);

  /** Pointer drag mapped to canvas px. */
  const startDrag = (
    e: ReactPointerEvent,
    onMove: (dx: number, dy: number, shift: boolean) => (d: DesignDoc) => DesignDoc,
    key: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const k = `${key}:${e.timeStamp}`;
    const move = (ev: PointerEvent) => apply(onMove((ev.clientX - sx) / scale, (ev.clientY - sy) / scale, ev.shiftKey), k);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onElementDown = (e: ReactPointerEvent, el: DesignElement) => {
    if (!interactive || el.locked) return;
    if (editingId === el.id) {
      if (el.type === "text") return; // typing inside it
      // Adjust mode on a picture/clip: dragging pans the crop, not the box.
      if ((el.type === "image" || el.type === "video") && el.fit === "cover") {
        const natural = naturalSizes.current[el.id];
        if (!natural) return;
        const g = coverGeometry(natural, { w: el.w, h: el.h }, el.crop);
        startDrag(
          e,
          (dx, dy) =>
            commands.patchElement<DesignImageElement | DesignVideoElement>(pageIndex, el.id, (cur) => ({
              ...cur,
              crop: cropForOffset(natural, { w: cur.w, h: cur.h }, cur.crop, { left: g.left + dx, top: g.top + dy }),
            })),
          `pan-${el.id}`,
        );
      }
      return;
    }
    select({ pageIndex, elementId: el.id });
    const start = { x: el.x, y: el.y };
    startDrag(
      e,
      (dx, dy, shift) =>
        commands.patchElement(pageIndex, el.id, (cur) => ({
          ...cur,
          x: Math.round(shift ? start.x : start.x + dx),
          y: Math.round(start.y + dy),
        })),
      `move-${el.id}`,
    );
  };

  const onHandleDown = (e: ReactPointerEvent, el: DesignElement, handle: Handle) => {
    const start = { x: el.x, y: el.y, w: el.w, h: el.h };
    startDrag(
      e,
      (dx, dy) =>
        commands.patchElement(pageIndex, el.id, (cur) => {
          let { x, y, w, h } = start;
          if (handle.includes("e")) w = Math.max(20, start.w + dx);
          if (handle.includes("s")) h = Math.max(20, start.h + dy);
          if (handle.includes("w")) {
            w = Math.max(20, start.w - dx);
            x = start.x + (start.w - w);
          }
          if (handle.includes("n")) {
            h = Math.max(20, start.h - dy);
            y = start.y + (start.h - h);
          }
          return { ...cur, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        }),
      `resize-${el.id}`,
    );
  };

  return (
    <div
      className={cn("relative shrink-0 overflow-hidden bg-black", className)}
      style={{ width: W * scale, height: H * scale }}
      onPointerDown={() => interactive && select({ pageIndex, elementId: null })}
    >
      <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      <div
        className="absolute left-0 top-0 origin-top-left select-none"
        style={{ width: W, height: H, transform: `scale(${scale})`, background: page.background }}
      >
        {page.elements.map((el) => (
          <ElementView
            key={el.id}
            inert={adjustingId !== null && adjustingId !== el.id}
            el={el}
            imageUrl={imageUrls[el.id]}
            videoUrl={videoUrl}
            cues={cues}
            selected={selectedId === el.id}
            editing={interactive && editingId === el.id}
            interactive={interactive}
            onNaturalSize={(size) => {
              naturalSizes.current[el.id] = size;
            }}
            onPointerDown={(e) => onElementDown(e, el)}
            onDoubleClick={() => {
              if (!interactive || el.locked) return;
              if (el.type === "text") setEditing(el.id);
              else if ((el.type === "image" || el.type === "video") && el.fit === "cover") setEditing(el.id);
            }}
            onCommitText={(spans) => {
              apply(commands.patchElement<DesignTextElement>(pageIndex, el.id, (cur) => ({ ...cur, spans })));
              setEditing(null);
            }}
            onZoom={(zoom) => apply(commands.patchElement<DesignImageElement | DesignVideoElement>(pageIndex, el.id, (cur) => ({ ...cur, crop: { ...cur.crop, zoom } })), `zoom-${el.id}`)}
            onDoneAdjust={() => setEditing(null)}
          />
        ))}
        {showSlots &&
          page.elements.map((el) =>
            el.slot ? (
              <div key={`slot-${el.id}`} className="pointer-events-none absolute rounded-br-md px-2 py-0.5 text-[18px] font-semibold text-white" style={{ left: el.x, top: el.y, background: el.slot.kind === "ai" ? "#DB2777" : "#0EA5E9" }}>
                {el.slot.kind === "ai" ? "AI" : el.slot.kind === "photo" ? "Photo" : el.slot.kind === "videoTitle" ? "Video title" : el.slot.kind === "channelName" ? "Channel" : "Subscribers"}
                {el.stack ? ` · ${el.stack}` : ""}
              </div>
            ) : null,
          )}
        {selectedId &&
          !adjustingId &&
          (() => {
            const el = page.elements.find((x) => x.id === selectedId);
            if (!el || el.locked) return null;
            return (
              <>
                <div
                  className="pointer-events-none absolute border-2 border-sky-500"
                  style={{ left: el.x - 2, top: el.y - 2, width: el.w + 4, height: el.h + 4 }}
                />
                {HANDLES.map((h) => (
                  <div
                    key={h}
                    onPointerDown={(e) => onHandleDown(e, el, h)}
                    className="absolute size-5 rounded-full border-2 border-sky-500 bg-white"
                    style={{
                      left: el.x + (h.includes("w") ? 0 : h.includes("e") ? el.w : el.w / 2) - 10,
                      top: el.y + (h.includes("n") ? 0 : h.includes("s") ? el.h : el.h / 2) - 10,
                      cursor: `${h}-resize`,
                    }}
                  />
                ))}
              </>
            );
          })()}
      </div>
    </div>
  );
}

function ElementView({
  inert,
  el,
  imageUrl,
  videoUrl,
  cues,
  selected,
  editing,
  interactive,
  onNaturalSize,
  onPointerDown,
  onDoubleClick,
  onCommitText,
  onZoom,
  onDoneAdjust,
}: {
  inert: boolean;
  el: DesignElement;
  imageUrl: string | undefined;
  videoUrl: string | null;
  cues: ReturnType<typeof buildDesignCaptionCues>;
  selected: boolean;
  editing: boolean;
  interactive: boolean;
  onNaturalSize: (size: { width: number; height: number }) => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
  onCommitText: (spans: DesignSpan[]) => void;
  onZoom: (zoom: number) => void;
  onDoneAdjust: () => void;
}) {
  const base: React.CSSProperties = {
    position: "absolute",
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    opacity: el.opacity,
    cursor: interactive && !el.locked ? "move" : "default",
    ...(inert ? { pointerEvents: "none" as const } : {}),
  };
  const hover = interactive && !selected && !el.locked ? "hover:outline hover:outline-[3px] hover:outline-sky-300/70" : "";

  if (el.type === "rect") {
    return (
      <div
        className={hover}
        onPointerDown={onPointerDown}
        style={{
          ...base,
          borderRadius: el.radius,
          ...(el.gradientTo
            ? { backgroundImage: `linear-gradient(180deg, ${rgba(el.fill)} 0%, ${rgba(el.gradientTo)} 100%)` }
            : { backgroundColor: rgba(el.fill) }),
        }}
      />
    );
  }
  if (el.type === "image") {
    return (
      <ImageView el={el} imageUrl={imageUrl} base={base} hover={hover} editing={editing} onNaturalSize={onNaturalSize} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onZoom={onZoom} onDoneAdjust={onDoneAdjust} />
    );
  }
  if (el.type === "video") {
    return (
      <VideoView el={el} videoUrl={videoUrl} base={base} hover={hover} editing={editing} interactive={interactive} onNaturalSize={onNaturalSize} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onZoom={onZoom} onDoneAdjust={onDoneAdjust} />
    );
  }
  if (el.type === "captions") {
    return <CaptionsView el={el} cues={cues} base={base} hover={hover} interactive={interactive} onPointerDown={onPointerDown} />;
  }
  return (
    <TextView el={el} base={base} hover={hover} editing={editing} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} onCommitText={onCommitText} />
  );
}

/**
 * A picture in its box. `cover` pictures are positioned by coverGeometry
 * (pan + zoom from `crop`), exactly as the exporter does. In adjust mode
 * (double-click) dragging pans and a floating slider zooms.
 */
function ImageView({ el, imageUrl, base, hover, editing, onNaturalSize, onPointerDown, onDoubleClick, onZoom, onDoneAdjust }: {
  el: DesignImageElement; imageUrl: string | undefined; base: React.CSSProperties; hover: string; editing: boolean;
  onNaturalSize: (size: { width: number; height: number }) => void; onPointerDown: (e: ReactPointerEvent) => void; onDoubleClick: () => void; onZoom: (zoom: number) => void; onDoneAdjust: () => void;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const g = natural ? coverGeometry(natural, { w: el.w, h: el.h }, el.crop, el.fit) : null;
  return (
    <div className={cn(hover, editing && "outline outline-[4px] outline-amber-400")} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={{ ...base, borderRadius: el.radius, overflow: "hidden", cursor: editing ? "grab" : base.cursor }}>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- canvas-px sized, drawn to match the exporter
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          onLoad={(e) => {
            const size = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight };
            setNatural(size);
            onNaturalSize(size);
          }}
          className="pointer-events-none absolute max-w-none"
          style={g ? { left: g.left, top: g.top, width: g.width, height: g.height } : { left: 0, top: 0, width: el.w, height: el.h, objectFit: el.fit }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-[28px] text-muted-foreground">image</div>
      )}
      {editing && <AdjustBar el={el} onZoom={onZoom} onDone={onDoneAdjust} />}
    </div>
  );
}

/** Zoom slider + Done for adjust mode, floating above the element. */
function AdjustBar({ el, onZoom, onDone }: { el: DesignImageElement | DesignVideoElement; onZoom: (zoom: number) => void; onDone: () => void }) {
  return (
    <div
      className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-popover/95 px-4 py-2 text-[20px] shadow-lg"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <span className="text-muted-foreground">Drag to reposition · Zoom</span>
      <input type="range" min={1} max={3} step={0.02} value={el.crop.zoom} onChange={(e) => onZoom(Number(e.target.value))} className="h-1 w-56 cursor-pointer accent-sky-500" />
      <span className="font-mono text-[18px]">{el.crop.zoom.toFixed(2)}×</span>
      <button type="button" onClick={onDone} className="rounded bg-foreground px-3 py-1 font-semibold text-background">Done</button>
    </div>
  );
}

/**
 * The page's clip: a <video> of the source, sized by coverGeometry from its
 * pixel size, kept inside [startSec, endSec] and driving PlaybackContext's
 * clock. Preloads metadata only; `#t=` puts the poster at the clip start.
 */
function VideoView({ el, videoUrl, base, hover, editing, interactive, onNaturalSize, onPointerDown, onDoubleClick, onZoom, onDoneAdjust }: {
  el: DesignVideoElement; videoUrl: string | null; base: React.CSSProperties; hover: string; editing: boolean; interactive: boolean;
  onNaturalSize: (size: { width: number; height: number }) => void; onPointerDown: (e: ReactPointerEvent) => void; onDoubleClick: () => void; onZoom: (zoom: number) => void; onDoneAdjust: () => void;
}) {
  const playback = useContext(PlaybackContext);
  const ref = useRef<HTMLVideoElement | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const g = natural ? coverGeometry(natural, { w: el.w, h: el.h }, el.crop, el.fit) : null;
  const { startSec, endSec } = el;
  const { playing, setPlaying, setTime, setDuration, seekRequest } = playback;

  // Play/pause follows the shared state; time reports back in clip seconds.
  useEffect(() => {
    const v = ref.current;
    if (!v || !interactive) return;
    if (playing) {
      if (v.currentTime < startSec || v.currentTime >= endSec) v.currentTime = startSec;
      void v.play().catch(() => setPlaying(false));
    } else v.pause();
  }, [playing, startSec, endSec, interactive, setPlaying]);
  useEffect(() => {
    const v = ref.current;
    if (!v || !seekRequest) return;
    v.currentTime = startSec + seekRequest.sec;
    setTime(seekRequest.sec);
  }, [seekRequest, startSec, setTime]);
  // Trim edits move the poster frame too.
  useEffect(() => {
    const v = ref.current;
    if (!v || playing) return;
    v.currentTime = startSec;
    setTime(0);
  }, [startSec, playing, setTime]);

  return (
    <div className={cn(hover, editing && "outline outline-[4px] outline-amber-400")} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={{ ...base, borderRadius: el.radius, overflow: "hidden", background: "#000", cursor: editing ? "grab" : base.cursor }}>
      {videoUrl ? (
        <video
          ref={ref}
          src={`${videoUrl}#t=${startSec.toFixed(2)}`}
          preload="metadata"
          playsInline
          muted={!interactive}
          onLoadedMetadata={(e) => {
            const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
            setNatural(size);
            onNaturalSize(size);
            if (interactive && Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (v.currentTime >= endSec) {
              v.pause();
              v.currentTime = startSec;
              setPlaying(false);
              setTime(0);
            } else setTime(Math.max(0, v.currentTime - startSec));
          }}
          onEnded={() => setPlaying(false)}
          className="pointer-events-none absolute max-w-none"
          style={g ? { left: g.left, top: g.top, width: g.width, height: g.height } : { left: 0, top: 0, width: el.w, height: el.h, objectFit: el.fit }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[28px] text-white/70">video</div>
      )}
      {editing && <AdjustBar el={el} onZoom={onZoom} onDone={onDoneAdjust} />}
    </div>
  );
}

/** What is being said right now, laid out like text. Without a clip on the
 *  page (or before the words load) it shows a placeholder so it can still
 *  be moved. */
function CaptionsView({ el, cues, base, hover, interactive, onPointerDown }: {
  el: DesignCaptionsElement; cues: ReturnType<typeof buildDesignCaptionCues>; base: React.CSSProperties; hover: string; interactive: boolean; onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const { timeSec } = useContext(PlaybackContext);
  const cue = activeCue(cues, timeSec) ?? cues[0] ?? null;
  const text = cue?.text ?? (interactive ? "Captions follow the clip" : "");
  const layout = useMemo(() => layoutCaptionCue(el, text), [el, text]);
  const font = FONTS[el.style.fontId];
  const shadow = el.style.shadow
    ? `${el.style.shadow.x}px ${el.style.shadow.y}px ${el.style.shadow.blur}px ${rgba({ color: el.style.shadow.color, alpha: el.style.shadow.alpha })}`
    : undefined;
  return (
    <div className={cn(hover, interactive && "outline-dashed outline-1 outline-sky-300/40")} onPointerDown={onPointerDown} style={{ ...base, opacity: cue ? el.opacity : el.opacity * 0.5 }}>
      {layout.lines.map((line, i) => (
        <div key={i} className="absolute flex whitespace-pre" style={{ left: line.x - el.x, top: line.y - el.y, height: layout.linePitchPx, lineHeight: `${layout.linePitchPx}px`, fontSize: layout.fontSizePx, fontFamily: `"${font.cssFamily}"`, fontWeight: font.cssWeight, color: el.style.color, ...(shadow ? { textShadow: shadow } : {}) }}>
          {line.words.map((w, wi) => <span key={wi}>{(wi > 0 ? " " : "") + w.text}</span>)}
        </div>
      ))}
    </div>
  );
}

function TextView({
  el,
  base,
  hover,
  editing,
  onPointerDown,
  onDoubleClick,
  onCommitText,
}: {
  el: DesignTextElement;
  base: React.CSSProperties;
  hover: string;
  editing: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
  onCommitText: (spans: DesignSpan[]) => void;
}) {
  const layout = useMemo(() => layoutDesignText(el), [el]);
  const font = FONTS[el.style.fontId];
  const shadow = el.style.shadow
    ? `${el.style.shadow.x}px ${el.style.shadow.y}px ${el.style.shadow.blur}px ${rgba({ color: el.style.shadow.color, alpha: el.style.shadow.alpha })}`
    : undefined;

  if (editing) return <TextEditor el={el} onCommit={onCommitText} />;

  return (
    <div className={hover} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={base}>
      {layout.lines.map((line, i) => (
        <div
          key={i}
          className="absolute flex whitespace-pre"
          style={{
            left: line.x - el.x,
            top: line.y - el.y,
            height: layout.linePitchPx,
            lineHeight: `${layout.linePitchPx}px`,
            fontSize: layout.fontSizePx,
            fontFamily: `"${font.cssFamily}"`,
            fontWeight: font.cssWeight,
            color: el.style.color,
            ...(shadow ? { textShadow: shadow } : {}),
          }}
        >
          {line.words.map((w, wi) => (
            <span key={wi} style={w.color ? { color: w.color } : undefined}>
              {(wi > 0 ? " " : "") + w.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Inline editing: a textarea in the element's box and font. Highlights
 * survive an edit — the coloured phrases are re-applied to the new text —
 * and the toolbar colours the current textarea selection.
 */
function TextEditor({ el, onCommit }: { el: DesignTextElement; onCommit: (spans: DesignSpan[]) => void }) {
  const font = FONTS[el.style.fontId];
  const initial = el.spans.map((s) => s.text).join("");
  const [text, setText] = useState(initial);
  const [colored, setColored] = useState<Array<{ phrase: string; color: string }>>(
    el.spans.filter((s) => s.color).map((s) => ({ phrase: s.text, color: s.color! })),
  );
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => onCommit(rehighlight(text, colored));
  const paint = (color: string | null) => {
    const ta = ref.current;
    if (!ta) return;
    const sel = text.slice(ta.selectionStart, ta.selectionEnd).trim();
    if (!sel) return;
    setColored((prev) => {
      const rest = prev.filter((c) => c.phrase.toLowerCase() !== sel.toLowerCase());
      return color ? [...rest, { phrase: sel, color }] : rest;
    });
    ta.focus();
  };

  return (
    <div style={{ position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCommit(el.spans);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
        }}
        className="h-full w-full resize-none bg-white/10 outline outline-[4px] outline-sky-500"
        style={{
          fontFamily: `"${font.cssFamily}"`,
          fontWeight: font.cssWeight,
          fontSize: el.style.sizePx,
          lineHeight: el.style.lineHeight,
          color: el.style.color,
          textAlign: el.style.align,
          textTransform: el.style.uppercase ? "uppercase" : "none",
        }}
      />
      <div
        className="absolute -top-16 left-0 flex items-center gap-2 rounded-lg bg-popover p-2 text-[20px] shadow-lg"
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="text-muted-foreground">Select words, then:</span>
        {[
          ["#FF3B3B", "Red"],
          ["#22E07A", "Green"],
          ["#FFE14D", "Yellow"],
        ].map(([c, label]) => (
          <button key={c} type="button" onClick={() => paint(c)} className="rounded px-3 py-1 font-semibold text-black" style={{ background: c }}>
            {label}
          </button>
        ))}
        <button type="button" onClick={() => paint(null)} className="rounded border border-border px-3 py-1">
          Plain
        </button>
        <button type="button" onClick={commit} className="rounded bg-foreground px-3 py-1 font-semibold text-background">
          Done
        </button>
      </div>
    </div>
  );
}

/** Split `text` into spans so each coloured phrase keeps its colour. */
export function rehighlight(text: string, colored: Array<{ phrase: string; color: string }>): DesignSpan[] {
  const marks: Array<{ start: number; end: number; color: string }> = [];
  const lower = text.toLowerCase();
  for (const c of colored) {
    const p = c.phrase.trim().toLowerCase();
    if (!p) continue;
    let from = 0;
    while (from <= lower.length) {
      const start = lower.indexOf(p, from);
      if (start < 0) break;
      const end = start + p.length;
      if (!marks.some((m) => start < m.end && end > m.start)) marks.push({ start, end, color: c.color });
      from = end;
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const spans: DesignSpan[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) spans.push({ text: text.slice(cursor, m.start) });
    spans.push({ text: text.slice(m.start, m.end), color: m.color });
    cursor = m.end;
  }
  if (cursor < text.length || spans.length === 0) spans.push({ text: text.slice(cursor) });
  return spans;
}
