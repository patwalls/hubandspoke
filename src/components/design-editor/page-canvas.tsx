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
import { ColorPicker } from "@/components/editor/color-picker";
import { FONTS, fontFaceCss } from "@/lib/clip-editor/fonts";
import type { EditorWord } from "@/lib/clip-editor/words";
import type { DesignArrowElement, DesignCaptionsElement, DesignChannelElement, DesignDoc, DesignElement, DesignImageElement, DesignPage, DesignSpan, DesignStatCardElement, DesignTextElement, DesignVideoElement, Rgba } from "@/lib/design-editor/doc";
import { layoutChannel, type ChannelInfo } from "@/lib/design-editor/channel";
import { colorsInDesignDoc } from "@/lib/design-editor/colors";
import { layoutStatCard, sparklineSvg, svgDataUrl } from "@/lib/design-editor/stat-card";
import { arrowBendPoint, arrowEnds, arrowFromEnds, arrowSvg, bendFromPoint, snapAngle } from "@/lib/design-editor/arrow";
import { pageVideo } from "@/lib/design-editor/doc";
import { activeCue, buildDesignCaptionCues, layoutCaptionCue } from "@/lib/design-editor/captions";
import { coverGeometry, cropForOffset, layoutDesignText } from "@/lib/design-editor/layout";
import { elementSnapTargets, snapMove, snapResize, snapThreshold, type SnapGuide } from "@/lib/editor/snap";
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
  /** Play (with sound) on a non-interactive canvas — the Post tab's preview. */
  enabled?: boolean;
}
export const PlaybackContext = createContext<PlaybackState>({ timeSec: 0, playing: false, durationSec: 0, setTime: () => {}, setPlaying: () => {}, setDuration: () => {}, seekRequest: null });

function rgba(c: Rgba): string {
  const r = parseInt(c.color.slice(1, 3), 16);
  const g = parseInt(c.color.slice(3, 5), 16);
  const b = parseInt(c.color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${c.alpha})`;
}

/** The axis-aligned box around some elements as drawn — tilted ones by
 *  their turned corners (a group's frame and its snapping box). */
function unionBox(els: Array<{ x: number; y: number; w: number; h: number; rotation?: number }>): { x: number; y: number; w: number; h: number } {
  if (els.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const e of els) {
    const t = ((e.rotation ?? 0) * Math.PI) / 180;
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    for (const [dx, dy] of [[-e.w / 2, -e.h / 2], [e.w / 2, -e.h / 2], [e.w / 2, e.h / 2], [-e.w / 2, e.h / 2]]) {
      xs.push(cx + dx * Math.cos(t) - dy * Math.sin(t));
      ys.push(cy + dx * Math.sin(t) + dy * Math.cos(t));
    }
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
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
  channels = {},
  scale,
  interactive,
  showSlots = false,
  snap = true,
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
  /** Channel element id → the account it shows (live data). */
  channels?: Record<string, ChannelInfo | null>;
  scale: number;
  interactive: boolean;
  /** Template mode: label every slot on the page. */
  showSlots?: boolean;
  /** Snap drags to the canvas centre/edges and other elements (⌥ bypasses). */
  snap?: boolean;
  className?: string;
}) {
  const { width: W, height: H } = doc.canvas;
  const selection = useDesign((s) => s.selection);
  const editingId = useDesign((s) => s.editingElementId);
  const select = useDesign((s) => s.select);
  const setEditing = useDesign((s) => s.setEditing);
  const apply = useDesign((s) => s.apply);
  const selectedId = interactive && selection.pageIndex === pageIndex ? selection.elementId : null;
  const selectedGroup = selectedId && selection.groupId ? selection.groupId : null;
  /** Pixel size of each picture/clip once loaded — the crop needs it. */
  const naturalSizes = useRef<Record<string, { width: number; height: number }>>({});
  /** Guide lines while a drag is snapping. */
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const snapTargetsFor = (movingId: string) =>
    elementSnapTargets(page.elements.filter((el) => el.id !== movingId).map((el) => ({ x: el.x, y: el.y, w: el.w, h: el.h })), { width: W, height: H }, { margin: 40 });
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
    onMove: (dx: number, dy: number, shift: boolean, alt: boolean) => (d: DesignDoc) => DesignDoc,
    key: string,
    onUp?: () => void,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    // preventDefault keeps focus where it was — in an inspector field or the
    // AI bar if that was last touched — and those swallow the arrow keys.
    // Clicking the stage means "work here": take focus off the field.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const sx = e.clientX;
    const sy = e.clientY;
    const k = `${key}:${e.timeStamp}`;
    const move = (ev: PointerEvent) => apply(onMove((ev.clientX - sx) / scale, (ev.clientY - sy) / scale, ev.shiftKey, ev.altKey), k);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides([]);
      onUp?.();
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
    // A grouped element: the first click takes the whole group (and a drag
    // moves it); a click — no drag — on an already-selected group drills
    // into this one layer. Canva's rule.
    // Already working inside this group (one layer selected) → stay inside.
    const insideGroup = !!el.group && !selectedGroup && page.elements.some((m) => m.id === selectedId && m.group === el.group);
    if (el.group && !insideGroup) {
      const groupId = el.group;
      const drillIn = selectedGroup === groupId;
      select({ pageIndex, elementId: el.id, groupId });
      const members = page.elements.filter((m) => m.group === groupId);
      const startBox = unionBox(members);
      const starts = new Map(members.map((m) => [m.id, { x: m.x, y: m.y }]));
      const targets = elementSnapTargets(page.elements.filter((m) => m.group !== groupId).map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h })), { width: W, height: H }, { margin: 40 });
      let moved = false;
      startDrag(
        e,
        (dx, dy, shift, alt) => {
          moved = moved || Math.abs(dx) + Math.abs(dy) > 2;
          let x = shift ? startBox.x : startBox.x + dx;
          let y = startBox.y + dy;
          if (snap && !alt) {
            const s = snapMove({ x, y, w: startBox.w, h: startBox.h }, targets, snapThreshold(scale));
            x = shift ? x : s.x;
            y = s.y;
            setGuides(s.guides.filter((g) => !(shift && g.axis === "x")));
          } else setGuides([]);
          const ddx = Math.round(x - startBox.x);
          const ddy = Math.round(y - startBox.y);
          return commands.patchGroup(pageIndex, groupId, (m) => {
            const s0 = starts.get(m.id);
            return s0 ? { ...m, x: s0.x + ddx, y: s0.y + ddy } : m;
          });
        },
        `move-group-${groupId}`,
        () => {
          if (drillIn && !moved) select({ pageIndex, elementId: el.id, groupId: null });
        },
      );
      return;
    }
    select({ pageIndex, elementId: el.id });
    const start = { x: el.x, y: el.y };
    const targets = snapTargetsFor(el.id);
    startDrag(
      e,
      (dx, dy, shift, alt) =>
        commands.patchElement(pageIndex, el.id, (cur) => {
          let x = shift ? start.x : start.x + dx;
          let y = start.y + dy;
          if (snap && !alt) {
            const s = snapMove({ x, y, w: cur.w, h: cur.h }, targets, snapThreshold(scale));
            x = shift ? x : s.x;
            y = s.y;
            setGuides(s.guides.filter((g) => !(shift && g.axis === "x")));
          } else setGuides([]);
          return { ...cur, x: Math.round(x), y: Math.round(y) };
        }),
      `move-${el.id}`,
    );
  };

  const onHandleDown = (e: ReactPointerEvent, el: DesignElement, handle: Handle) => {
    const start = { x: el.x, y: el.y, w: el.w, h: el.h };
    const targets = snapTargetsFor(el.id);
    startDrag(
      e,
      (dx, dy, _shift, alt) =>
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
          if (snap && !alt) {
            const s = snapResize({ x, y, w, h }, handle, targets, snapThreshold(scale));
            ({ x, y, w, h } = s.rect);
            setGuides(s.guides);
          } else setGuides([]);
          return { ...cur, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        }),
      `resize-${el.id}`,
    );
  };

  /** Drag an arrow's tail or head: the other end stays put; shift snaps
   *  the angle to 15°. */
  const onArrowEndDown = (e: ReactPointerEvent, el: DesignArrowElement, end: "tail" | "head") => {
    const start = arrowEnds(el);
    startDrag(
      e,
      (dx, dy, shift) =>
        commands.patchElement<DesignArrowElement>(pageIndex, el.id, (cur) => {
          const fixed = end === "head" ? start.tail : start.head;
          let moved = { x: start[end].x + dx, y: start[end].y + dy };
          if (shift) moved = snapAngle(fixed, moved);
          const [tail, head] = end === "head" ? [fixed, moved] : [moved, fixed];
          return { ...cur, ...arrowFromEnds(tail, head, cur.bend, cur.thickness) };
        }),
      `arrow-${end}-${el.id}`,
    );
  };

  /** Drag the middle handle sideways to curve the arrow. */
  const onArrowBendDown = (e: ReactPointerEvent, el: DesignArrowElement) => {
    const start = arrowBendPoint(el);
    const ends = arrowEnds(el);
    startDrag(
      e,
      (dx, dy) =>
        commands.patchElement<DesignArrowElement>(pageIndex, el.id, (cur) => {
          const bend = bendFromPoint(cur, { x: start.x + dx, y: start.y + dy });
          // Re-derive the box so its height fits the new bulge, ends fixed.
          return { ...cur, bend, ...arrowFromEnds(ends.tail, ends.head, bend, cur.thickness) };
        }),
      `arrow-bend-${el.id}`,
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
            channel={channels[el.id] ?? null}
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
        {guides.map((g, i) => (
          <div
            key={`${g.axis}-${g.at}-${i}`}
            className="pointer-events-none absolute"
            style={g.axis === "x" ? { left: g.at - 1, top: 0, width: 2, height: H, background: "#EC4899" } : { top: g.at - 1, left: 0, height: 2, width: W, background: "#EC4899" }}
          />
        ))}
        {showSlots &&
          page.elements.map((el) =>
            el.slot ? (
              <div key={`slot-${el.id}`} className="pointer-events-none absolute rounded-br-md px-2 py-0.5 text-[18px] font-semibold text-white" style={{ left: el.x, top: el.y, background: el.slot.kind === "ai" ? "#DB2777" : "#0EA5E9" }}>
                {el.slot.kind === "ai" ? "AI" : el.slot.kind === "photo" ? "Photo" : el.slot.kind === "frame" ? "Frame" : el.slot.kind === "cutout" ? "Cutout" : el.slot.kind === "screen" ? "Screen" : el.slot.kind === "videoTitle" ? "Video title" : el.slot.kind === "channelName" ? "Channel" : el.slot.kind === "dmKeyword" ? "DM keyword" : "Subscribers"}
                {el.stack ? ` · ${el.stack}` : ""}
              </div>
            ) : null,
          )}
        {selectedId &&
          !adjustingId &&
          (() => {
            const el = page.elements.find((x) => x.id === selectedId);
            if (!el || el.locked) return null;
            if (selectedGroup) {
              const b = unionBox(page.elements.filter((m) => m.group === selectedGroup));
              return (
                <div className="pointer-events-none absolute border-sky-500" style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderWidth: 2 / scale, borderStyle: "dashed" }}>
                  <span className="absolute left-0 rounded-b bg-sky-500 font-semibold text-white" style={{ top: "100%", fontSize: 11 / scale, padding: `${1 / scale}px ${5 / scale}px` }}>Group · click again for one layer</span>
                </div>
              );
            }
            if (el.type === "arrow") {
              const { tail, head } = arrowEnds(el);
              const mid = arrowBendPoint(el);
              // Sized in SCREEN px (the stage is scaled down ~3×).
              const d = 16 / scale;
              const ring = { width: d, height: d, borderWidth: 3 / scale };
              const dot = "absolute rounded-full border-sky-500 bg-white shadow";
              return (
                <>
                  <div onPointerDown={(e) => onArrowEndDown(e, el, "tail")} title="Drag to move the tail (shift snaps the angle)" className={dot} style={{ ...ring, left: tail.x - d / 2, top: tail.y - d / 2, cursor: "crosshair" }} />
                  <div onPointerDown={(e) => onArrowEndDown(e, el, "head")} title="Drag to move the head (shift snaps the angle)" className={dot} style={{ ...ring, left: head.x - d / 2, top: head.y - d / 2, cursor: "crosshair" }} />
                  <div onPointerDown={(e) => onArrowBendDown(e, el)} title="Drag sideways to curve the arrow" className="absolute rounded-full border-pink-500 bg-white shadow" style={{ ...ring, left: mid.x - d / 2, top: mid.y - d / 2, cursor: "grab" }} />
                </>
              );
            }
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
  channel,
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
  channel: ChannelInfo | null;
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
    // Tilt — the same transform the exporter applies (render-tree.ts);
    // video/captions are drawn by ffmpeg, which doesn't rotate.
    ...(el.rotation && el.type !== "video" && el.type !== "captions" ? { transform: `rotate(${el.rotation}deg)`, transformOrigin: "center" } : {}),
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
            ? { backgroundImage: `linear-gradient(${el.gradientDirection === "up" ? 0 : 180}deg, ${rgba(el.fill)} 0%, ${rgba(el.gradientTo)} 100%)` }
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
  if (el.type === "channel") {
    return <ChannelView el={el} info={channel} base={base} hover={hover} onPointerDown={onPointerDown} />;
  }
  if (el.type === "statCard") {
    return <StatCardView el={el} base={base} hover={hover} onPointerDown={onPointerDown} />;
  }
  if (el.type === "arrow") {
    return <ArrowView el={el} base={base} interactive={interactive} onPointerDown={onPointerDown} />;
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
  const live = interactive || !!playback.enabled;

  // Play/pause follows the shared state; time reports back in clip seconds.
  useEffect(() => {
    const v = ref.current;
    if (!v || !live) return;
    if (playing) {
      if (v.currentTime < startSec || v.currentTime >= endSec) v.currentTime = startSec;
      void v.play().catch(() => setPlaying(false));
    } else v.pause();
  }, [playing, startSec, endSec, live, setPlaying]);
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
          muted={!live}
          onLoadedMetadata={(e) => {
            const size = { width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight };
            setNatural(size);
            onNaturalSize(size);
            if (live && Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
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
    <div className={hover} onPointerDown={onPointerDown} style={{ ...base, opacity: cue ? el.opacity : el.opacity * 0.5 }}>
      {layout.lines.map((line, i) => (
        <div key={i} className="absolute flex whitespace-pre" style={{ left: line.x - el.x, top: line.y - el.y, height: layout.linePitchPx, lineHeight: `${layout.linePitchPx}px`, fontSize: layout.fontSizePx, fontFamily: `"${font.cssFamily}"`, fontWeight: font.cssWeight, color: el.style.color, letterSpacing: `${el.style.letterSpacing ?? 0}em`, ...(shadow ? { textShadow: shadow } : {}) }}>
          {line.words.map((w, wi) => <span key={wi}>{(wi > 0 ? " " : "") + w.text}</span>)}
        </div>
      ))}
    </div>
  );
}

/** The brand's channel: avatar (or initial), name ✓, followers — from the
 *  same layout the exporter draws. */
function ChannelView({ el, info, base, hover, onPointerDown }: { el: DesignChannelElement; info: ChannelInfo | null; base: React.CSSProperties; hover: string; onPointerDown: (e: ReactPointerEvent) => void }) {
  const l = useMemo(() => layoutChannel(el, info), [el, info]);
  const [broken, setBroken] = useState(false);
  const showImg = !!info?.avatarUrl && !broken;
  return (
    <div className={hover} onPointerDown={onPointerDown} style={base}>
      <div className="absolute overflow-hidden rounded-full" style={{ left: 0, top: 0, width: l.avatar.d, height: l.avatar.d, background: el.theme === "light" ? "#111111" : "#FFFFFF" }}>
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={info!.avatarUrl!} alt="" draggable={false} onError={() => setBroken(true)} className="pointer-events-none h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center" style={{ fontFamily: `"${FONTS.anton.cssFamily}"`, fontSize: Math.round(l.avatar.d * 0.58), color: el.theme === "light" ? "#FFFFFF" : "#111111" }}>{l.initial}</span>
        )}
      </div>
      {[l.name, l.followers].map((t) =>
        t ? <StaticText key={t.id} el={t} originX={el.x} originY={el.y} /> : null,
      )}
    </div>
  );
}

/** A laid-out text element drawn relative to a parent box. */
/** The stat card, from the same layout the exporter draws: card, label /
 *  value / sub, and the chart as an <img> of the identical SVG bytes. */
function StatCardView({ el, base, hover, onPointerDown }: { el: DesignStatCardElement; base: React.CSSProperties; hover: string; onPointerDown: (e: ReactPointerEvent) => void }) {
  const l = useMemo(() => layoutStatCard(el), [el]);
  const chartUrl = useMemo(() => (l.chart ? svgDataUrl(sparklineSvg(el, l.chart.w, l.chart.h)) : null), [el, l.chart]);
  return (
    <div className={hover} onPointerDown={onPointerDown} style={{ ...base, overflow: "hidden", backgroundColor: l.bg, border: `2px solid ${l.border}`, borderRadius: el.radius, ...(el.shadow ? { boxShadow: "0 30px 60px rgba(0,0,0,0.55)" } : {}) }}>
      {[l.label, l.value, l.sub].map((t) => (t ? <StaticText key={t.id} el={t} originX={0} originY={0} /> : null))}
      {l.chart && chartUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the exporter draws this exact SVG
        <img src={chartUrl} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ left: l.chart.x, top: l.chart.y, width: l.chart.w, height: l.chart.h }} />
      )}
    </div>
  );
}

/** An arrow: the exporter's SVG drawn inline, spilling past its box. Only
 *  the stroke is clickable (a fat invisible path along the shaft), so the
 *  empty corners of a curved arrow's box don't steal clicks from what's
 *  under it. */
function ArrowView({ el, base, interactive, onPointerDown }: { el: DesignArrowElement; base: React.CSSProperties; interactive: boolean; onPointerDown: (e: ReactPointerEvent) => void }) {
  const a = useMemo(() => arrowSvg(el), [el]);
  return (
    <div onPointerDown={onPointerDown} style={{ ...base, pointerEvents: "none" }}>
      <div className="absolute" style={{ left: -a.margin, top: -a.margin, width: a.width, height: a.height }} dangerouslySetInnerHTML={{ __html: a.svg }} />
      {interactive && !el.locked && (
        <svg className="absolute overflow-visible" style={{ left: -a.margin, top: -a.margin, width: a.width, height: a.height }} viewBox={`0 0 ${a.width} ${a.height}`}>
          <path d={a.centerline} fill="none" stroke="transparent" strokeWidth={Math.max(el.thickness + 24, 36)} strokeLinecap="round" style={{ pointerEvents: "stroke", cursor: "move" }} />
        </svg>
      )}
    </div>
  );
}

function StaticText({ el, originX, originY }: { el: DesignTextElement; originX: number; originY: number }) {
  const layout = useMemo(() => layoutDesignText(el), [el]);
  const font = FONTS[el.style.fontId];
  return (
    <>
      {layout.lines.map((line, i) => (
        <div key={i} className="absolute flex whitespace-pre" style={{ left: line.x - originX, top: line.y - originY, height: layout.linePitchPx, lineHeight: `${layout.linePitchPx}px`, fontSize: layout.fontSizePx, fontFamily: `"${font.cssFamily}"`, fontWeight: font.cssWeight, color: el.style.color }}>
          {line.words.map((w, wi) => <span key={wi}>{(wi > 0 ? " " : "") + w.text}</span>)}
        </div>
      ))}
    </>
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

  const doc = useDesign((s) => s.doc);
  const usedColors = useMemo(() => colorsInDesignDoc(doc), [doc]);
  // The custom-colour picker takes focus from the textarea, so remember the
  // selection when it opens and don't treat that blur as leaving the editor.
  const pickerOpen = useRef(false);
  const pickerRange = useRef<[number, number]>([0, 0]);
  const [pickerValue, setPickerValue] = useState(el.style.color);

  const commit = () => onCommit(rehighlight(text, colored));
  const selectedPhrase = (start: number, end: number) => text.slice(start, end).trim();
  const paint = (color: string | null, range?: [number, number]) => {
    const ta = ref.current;
    if (!ta) return;
    const sel = range ? selectedPhrase(...range) : selectedPhrase(ta.selectionStart, ta.selectionEnd);
    if (!sel) return;
    setColored((prev) => {
      const rest = prev.filter((c) => c.phrase.toLowerCase() !== sel.toLowerCase());
      return color ? [...rest, { phrase: sel, color }] : rest;
    });
    if (!range) ta.focus();
  };
  const onPickerOpenChange = (open: boolean) => {
    const ta = ref.current;
    if (!ta) return;
    pickerOpen.current = open;
    if (open) {
      pickerRange.current = [ta.selectionStart, ta.selectionEnd];
      const sel = selectedPhrase(ta.selectionStart, ta.selectionEnd).toLowerCase();
      setPickerValue(colored.find((c) => c.phrase.toLowerCase() === sel)?.color ?? el.style.color);
    } else {
      ta.focus();
      ta.setSelectionRange(...pickerRange.current);
    }
  };

  return (
    <div style={{ position: "absolute", left: el.x, top: el.y, width: el.w, height: el.h }} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!pickerOpen.current) commit();
        }}
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
        <ColorPicker
          value={pickerValue}
          onChange={(hex) => {
            setPickerValue(hex);
            paint(hex, pickerRange.current);
          }}
          onOpenChange={onPickerOpenChange}
          usedColors={usedColors}
          label="Custom colour"
          className="px-2 py-1 text-[20px]"
        />
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
