"use client";

/**
 * The stage — a live, WYSIWYG preview of the export.
 *
 * It draws the canvas at its TRUE pixel size (e.g. 1080×1920) inside a
 * CSS-scaled wrapper, so every coordinate here is a canvas pixel — the exact
 * numbers layout.ts produced and the exact numbers the ASS script hands to
 * libass. No second set of "preview" math to drift out of sync with export.
 *
 * Everything on the stage can be dragged: text and captions anywhere, the
 * video vertically (fit) or horizontally (fill), images (logos) anywhere and
 * resized by their corner. Text layers have Canva's handles: the sides set
 * the wrap width, the corners scale the text, and with shrink-to-fit on the
 * top/bottom set the box height. Drags go through the store's `apply` with a
 * coalesce key, so one drag = one undo step.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import type { CaptionsLayer, ClipEditDoc, ImageLayer, TextLayer, TextStyle } from "@/lib/clip-editor/doc";
import { FONTS, fontFaceCss } from "@/lib/clip-editor/fonts";
import type { TextBlockLayout } from "@/lib/clip-editor/layout";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import { resolveVideoBox } from "@/lib/clip-editor/video-box";
import { activeCaptionAt, type Scene } from "@/lib/clip-editor/scene";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";
import { ImageIcon, MagnetIcon, PlayIcon, TypeIcon } from "lucide-react";
import { createImageLayer, createTextLayer } from "@/lib/clip-editor/doc";
import { LogoPicker } from "@/components/editor/logo-picker";
import { readSnapEnabled, snapMove, snapThreshold, writeSnapEnabled, type SnapGuide, type SnapTarget } from "@/lib/editor/snap";

interface StageProps {
  plan: RenderPlan;
  scene: Scene;
  engine: PlaybackEngine;
  videoUrl: string;
  /** For the logo library behind "+ Logo". */
  brand: string;
  /** "preview": the finished clip only — no tools, handles or outlines, a
   *  play/scrub overlay instead. What the Post tab's platform mock shows. */
  variant?: "edit" | "preview";
}

function textCss(style: TextStyle, layout: TextBlockLayout): React.CSSProperties {
  const font = FONTS[style.fontId];
  const outlinePx = (style.outlinePct / 100) * layout.fontSizePx;
  return {
    fontFamily: `"${font.cssFamily}"`,
    fontWeight: font.cssWeight,
    fontSize: layout.fontSizePx,
    lineHeight: `${layout.linePitchPx}px`,
    height: layout.linePitchPx,
    color: style.color,
    letterSpacing: `${style.letterSpacing ?? 0}em`,
    whiteSpace: "pre",
    // libass draws the outline OUTSIDE the glyph; a CSS stroke is centered on
    // the edge, so double the width and paint it under the fill to match.
    ...(outlinePx > 0
      ? {
          WebkitTextStroke: `${outlinePx * 2}px ${style.outlineColor}`,
          paintOrder: "stroke fill",
        }
      : {}),
    ...(style.shadow
      ? {
          textShadow: `${(style.shadow.xPct / 100) * layout.fontSizePx}px ${(style.shadow.yPct / 100) * layout.fontSizePx}px ${(style.shadow.blurPct / 100) * layout.fontSizePx}px ${rgba(style.shadow.color, style.shadow.alpha)}`,
        }
      : {}),
  };
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${alpha})`;
}

/** The rounded box behind one line (`style.box`), in canvas px. Drawn as
 *  its own element under the text — the exporter draws the same rectangle
 *  as an ASS vector event (ass.ts → boxEvent). */
function LineBox({ style, layout, line, opacity }: { style: TextStyle; layout: TextBlockLayout; line: TextBlockLayout["lines"][number]; opacity?: number }) {
  if (!style.box) return null;
  const pad = (style.box.padPct / 100) * layout.fontSizePx;
  return (
    <div
      className="absolute"
      style={{
        left: line.x - pad,
        top: line.topY,
        width: line.widthPx + pad * 2,
        height: layout.linePitchPx,
        borderRadius: (style.box.radiusPct / 100) * layout.fontSizePx,
        background: rgba(style.box.color, style.box.alpha),
        opacity,
      }}
    />
  );
}

export function Stage({ plan, scene, engine, videoUrl, brand, variant = "edit" }: StageProps) {
  const isPreview = variant === "preview";
  const { width: W, height: H } = plan.canvas;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  const [scale, setScale] = useState(0);
  const [sourceAspect, setSourceAspect] = useState(16 / 9);

  // Only the MODE is React state here (it flips a couple of times a session);
  // the clock itself never is.
  const [previewing, setPreviewing] = useState(false);
  /** The guide lines while a drag is snapping; ⌥ drags freely. */
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  /** Natural aspect (w/h) of each image layer once its picture has loaded —
   *  what turns a width into a box for snapping and the resize handle. */
  const [imageAspect, setImageAspect] = useState<Record<string, number>>({});
  const imageUrls = useEditor((s) => s.imageUrls);
  const [snapOn, setSnapOn] = useState(() => (typeof window === "undefined" ? true : readSnapEnabled()));
  useEffect(
    () => engine.subscribe((snap) => setPreviewing(snap.mode === "preview")),
    [engine],
  );

  const apply = useEditor((s) => s.apply);
  const editSelection = useEditor((s) => s.stageSelection);
  const selection = isPreview ? null : editSelection;
  const setSelection = useEditor((s) => s.setStageSelection);
  const registerImageUrl = useEditor((s) => s.registerImageUrl);

  const addText = () => {
    const layer = createTextLayer({ text: "Your text", canvas: plan.canvas });
    apply(commands.addLayer(layer));
    setSelection({ kind: "layer", id: layer.id });
  };
  const addImage = (logo: { src: ImageLayer["src"]; previewUrl: string }) => {
    const layer = createImageLayer({ src: logo.src, canvas: plan.canvas });
    registerImageUrl(layer.id, logo.previewUrl);
    apply(commands.addLayer(layer));
    setSelection({ kind: "layer", id: layer.id });
  };

  // Fit the true-size canvas into whatever box the dialog gives us.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      setScale(Math.min(width / W, height / H));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  useEffect(() => {
    if (!videoA.current || !videoB.current) return;
    engine.attach(videoA.current, videoB.current);
    return () => engine.detach();
  }, [engine]);

  // Same geometry function the exporter uses — see video-box.ts. The source
  // size only matters as a ratio here, so any multiple of the aspect works.
  const box = useMemo(
    () => resolveVideoBox(plan.canvas, plan.video, { width: sourceAspect * 1080, height: 1080 }),
    [plan.canvas, plan.video, sourceAspect],
  );
  const videoBox = { left: box.x, top: box.y, width: box.width, height: box.height };

  /** Start a drag that maps pointer movement (in canvas px) to a doc change. */
  const startDrag = (
    e: PointerEvent,
    onMove: (dxCanvas: number, dyCanvas: number, alt: boolean) => (doc: ClipEditDoc) => ClipEditDoc,
    coalesceKey: string,
  ) => {
    if (scale === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Take focus off an inspector field so the arrow keys nudge the layer
    // instead of moving a slider (preventDefault would keep it there).
    (document.activeElement as HTMLElement | null)?.blur?.();
    const startX = e.clientX;
    const startY = e.clientY;
    // Unique per gesture so two separate drags are two undo steps.
    const key = `${coalesceKey}:${e.timeStamp}`;
    const move = (ev: globalThis.PointerEvent) => {
      apply(onMove((ev.clientX - startX) / scale, (ev.clientY - startY) / scale, ev.altKey), key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides([]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clampPct = (n: number) => Math.max(0, Math.min(100, n));

  /**
   * Vertical snap targets for a layer's anchor edge: canvas centre and
   * thirds, the video's top/bottom (and a hand's width off them, where a
   * hook or captions usually sit), and the other text layer's edges.
   */
  const layerSnapTargets = (movingId: string): SnapTarget[] => {
    const gap = Math.round(H * 0.02);
    const t: SnapTarget[] = [
      { at: H / 2, kind: "center" },
      { at: H / 3, kind: "third" },
      { at: (2 * H) / 3, kind: "third" },
      { at: videoBox.top, kind: "video" },
      { at: videoBox.top + videoBox.height, kind: "video" },
      { at: videoBox.top - gap, kind: "video" },
      { at: videoBox.top + videoBox.height + gap, kind: "video" },
    ];
    for (const block of scene.textBlocks) {
      if (block.layer.id === movingId) continue;
      t.push({ at: block.layout.top, kind: "element" }, { at: block.layout.bottom, kind: "element" });
    }
    return t;
  };

  /** Snap targets for a moving box: canvas edges/centre/margins, the
   *  video's edges, and every other layer's edges and centre. */
  const boxTargets = (movingId: string) => {
    const margin = Math.round(Math.min(W, H) * 0.04);
    const t: { x: SnapTarget[]; y: SnapTarget[] } = {
      x: [{ at: 0, kind: "edge" }, { at: W, kind: "edge" }, { at: W / 2, kind: "center" }, { at: margin, kind: "edge" }, { at: W - margin, kind: "edge" }, { at: videoBox.left, kind: "video" }, { at: videoBox.left + videoBox.width, kind: "video" }],
      y: [...layerSnapTargets(movingId), { at: 0, kind: "edge" }, { at: H, kind: "edge" }, { at: margin, kind: "edge" }, { at: H - margin, kind: "edge" }],
    };
    const others = plan.imageLayers.filter((l) => l.id !== movingId).map(imageRect);
    for (const block of scene.textBlocks) if (block.layer.id !== movingId) others.push(textRect(block.layer, block.layout));
    for (const o of others) {
      t.x.push({ at: o.x, kind: "element" }, { at: o.x + o.w / 2, kind: "element" }, { at: o.x + o.w, kind: "element" });
      t.y.push({ at: o.y + o.h / 2, kind: "element" });
    }
    return t;
  };

  /** Move a text layer (or the captions) anywhere; x and y follow the
   *  pointer by the snapped delta, so the anchor never matters. */
  const dragText = (e: PointerEvent, layer: TextLayer | CaptionsLayer, rect: Rect) => {
    setSelection({ kind: "layer", id: layer.id });
    const start = { xPct: layer.xPct, yPct: layer.yPct };
    const targets = boxTargets(layer.id);
    startDrag(
      e,
      (dx, dy, alt) =>
        commands.patchLayer(layer.id, (l) => {
          let moved = { ...rect, x: rect.x + dx, y: rect.y + dy };
          if (snapOn && !alt) {
            const snapped = snapMove(moved, targets, snapThreshold(scale));
            moved = { ...moved, x: snapped.x, y: snapped.y };
            setGuides(snapped.guides);
          } else setGuides([]);
          return { ...l, xPct: clampPct(start.xPct + ((moved.x - rect.x) / W) * 100), yPct: clampPct(start.yPct + ((moved.y - rect.y) / H) * 100) };
        }),
      `drag-layer-${layer.id}`,
    );
  };

  /** A text layer's handles. Sides: wrap width (text rewraps). Corners:
   *  scale width + font size together (the opposite corner stays). Top/
   *  bottom (shrink-to-fit only): the box height. */
  const resizeText = (e: PointerEvent, layer: TextLayer, rect: Rect, handle: Handle) => {
    setSelection({ kind: "layer", id: layer.id });
    const start = { ...layer, style: { ...layer.style } };
    const fromLeft = handle.includes("w");
    const fromTop = handle.startsWith("n");
    const horizontal = handle.includes("e") || fromLeft;
    const vertical = handle.startsWith("n") || handle.startsWith("s");
    const corner = horizontal && vertical;
    const anchorYFor = (top: number, h: number) => (start.anchor === "top" ? top : start.anchor === "center" ? top + h / 2 : top + h);
    startDrag(
      e,
      (dx, dy) =>
        commands.patchLayer<TextLayer>(layer.id, (l) => {
          if (horizontal) {
            const w = Math.max(W * 0.1, Math.min(W, rect.w + (fromLeft ? -dx : dx)));
            const left = fromLeft ? rect.x + rect.w - w : rect.x;
            const next: TextLayer = { ...l, widthPct: (w / W) * 100, xPct: clampPct(((left + w / 2) / W) * 100) };
            if (!corner) return next;
            const f = w / rect.w;
            const h = rect.h * f;
            const top = fromTop ? rect.y + rect.h - h : rect.y;
            return {
              ...next,
              yPct: clampPct((anchorYFor(top, h) / H) * 100),
              fitHeightPct: start.fitHeightPct == null ? null : Math.max(2, Math.min(100, start.fitHeightPct * f)),
              style: { ...l.style, sizePct: Math.max(0.5, Math.min(20, Math.round(start.style.sizePct * f * 100) / 100)) },
            };
          }
          const h = Math.max(H * 0.02, Math.min(H, rect.h + (fromTop ? -dy : dy)));
          const top = fromTop ? rect.y + rect.h - h : rect.y;
          return { ...l, fitHeightPct: (h / H) * 100, yPct: clampPct((anchorYFor(top, h) / H) * 100) };
        }),
      `resize-text-${layer.id}`,
    );
  };

  const dragVideo = (e: PointerEvent) => {
    setSelection({ kind: "video" });
    const start = { ...plan.video };
    const overflowX = videoBox.width - W;
    startDrag(
      e,
      (dx, dy) =>
        start.fit === "contain"
          ? commands.patchVideo({ yPct: clampPct(start.yPct + (dy / H) * 100) })
          : commands.patchVideo({
              panXPct:
                overflowX > 0 ? clampPct(start.panXPct - (dx / overflowX) * 100) : 50,
            }),
      "drag-video",
    );
  };

  /** The canvas-px box of an image layer (height from its loaded aspect). */
  const imageRect = (layer: ImageLayer) => {
    const w = (layer.widthPct / 100) * W;
    const h = w / (imageAspect[layer.id] ?? 1);
    const cx = (layer.xPct / 100) * W;
    const y = (layer.yPct / 100) * H;
    const top = layer.anchor === "top" ? y : layer.anchor === "center" ? y - h / 2 : y - h;
    return { x: cx - w / 2, y: top, w, h };
  };

  /** The canvas-px box of a text layer: its wrap width × its block height
   *  (or the shrink-to-fit box). What the handles and the outline follow. */
  const textRect = (layer: TextLayer, layout: TextBlockLayout): Rect => {
    const w = (layer.widthPct / 100) * W;
    const x = (layer.xPct / 100) * W - w / 2;
    if (layer.fitHeightPct == null) return { x, y: layout.top, w, h: layout.bottom - layout.top };
    const h = (layer.fitHeightPct / 100) * H;
    const ay = (layer.yPct / 100) * H;
    return { x, y: layer.anchor === "top" ? ay : layer.anchor === "center" ? ay - h / 2 : ay - h, w, h };
  };

  const dragImage = (e: PointerEvent, layer: ImageLayer) => {
    setSelection({ kind: "layer", id: layer.id });
    const start = imageRect(layer);
    const others = plan.imageLayers.filter((l) => l.id !== layer.id).map(imageRect);
    for (const block of scene.textBlocks) {
      others.push({ x: block.layout.left, y: block.layout.top, w: block.layout.right - block.layout.left, h: block.layout.bottom - block.layout.top });
    }
    const margin = Math.round(Math.min(W, H) * 0.04);
    const targets: { x: SnapTarget[]; y: SnapTarget[] } = {
      x: [{ at: 0, kind: "edge" as const }, { at: W, kind: "edge" as const }, { at: W / 2, kind: "center" as const }, { at: margin, kind: "edge" as const }, { at: W - margin, kind: "edge" as const }, { at: videoBox.left, kind: "video" as const }, { at: videoBox.left + videoBox.width, kind: "video" as const }],
      y: [{ at: 0, kind: "edge" as const }, { at: H, kind: "edge" as const }, { at: H / 2, kind: "center" as const }, { at: margin, kind: "edge" as const }, { at: H - margin, kind: "edge" as const }, { at: videoBox.top, kind: "video" as const }, { at: videoBox.top + videoBox.height, kind: "video" as const }],
    };
    for (const o of others) {
      targets.x.push({ at: o.x, kind: "element" }, { at: o.x + o.w / 2, kind: "element" }, { at: o.x + o.w, kind: "element" });
      targets.y.push({ at: o.y, kind: "element" }, { at: o.y + o.h / 2, kind: "element" }, { at: o.y + o.h, kind: "element" });
    }
    startDrag(
      e,
      (dx, dy, alt) =>
        commands.patchLayer<ImageLayer>(layer.id, (l) => {
          let rect = { ...start, x: start.x + dx, y: start.y + dy };
          if (snapOn && !alt) {
            const snapped = snapMove(rect, targets, snapThreshold(scale));
            rect = { ...rect, x: snapped.x, y: snapped.y };
            setGuides(snapped.guides);
          } else setGuides([]);
          const anchorY = l.anchor === "top" ? rect.y : l.anchor === "center" ? rect.y + rect.h / 2 : rect.y + rect.h;
          return { ...l, xPct: clampPct(((rect.x + rect.w / 2) / W) * 100), yPct: clampPct((anchorY / H) * 100) };
        }),
      `drag-image-${layer.id}`,
    );
  };

  /** Corner handle: width follows the pointer, the top-left corner stays. */
  const resizeImage = (e: PointerEvent, layer: ImageLayer) => {
    setSelection({ kind: "layer", id: layer.id });
    const start = imageRect(layer);
    const aspect = imageAspect[layer.id] ?? 1;
    startDrag(
      e,
      (dx) =>
        commands.patchLayer<ImageLayer>(layer.id, (l) => {
          const w = Math.max(W * 0.02, Math.min(W, start.w + dx));
          const h = w / aspect;
          const cx = start.x + w / 2;
          const anchorY = l.anchor === "top" ? start.y : l.anchor === "center" ? start.y + h / 2 : start.y + h;
          return { ...l, widthPct: (w / W) * 100, xPct: clampPct((cx / W) * 100), yPct: clampPct((anchorY / H) * 100) };
        }),
      `resize-image-${layer.id}`,
    );
  };

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full w-full items-center justify-center"
      onPointerDown={() => !isPreview && setSelection(null)}
    >
      <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      <div
        className={cn(
          "relative shrink-0 overflow-hidden",
          !isPreview && "rounded-lg shadow-xl ring-1 ring-black/20 transition-shadow",
          // Amber = "this is not your clip". Same colour as the transcript's
          // preview word and the transport, so the three read as one state.
          previewing && !isPreview && "ring-4 ring-amber-400",
        )}
        style={{ width: W * scale, height: H * scale, visibility: scale ? "visible" : "hidden" }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left select-none"
          style={{
            width: W,
            height: H,
            transform: `scale(${scale})`,
            background: plan.canvas.background,
          }}
        >
          <div
            className={cn(
              "absolute cursor-grab overflow-hidden active:cursor-grabbing",
              selection?.kind === "video" && "outline-dashed outline-[6px] outline-sky-400",
            )}
            style={{ ...videoBox, borderRadius: box.radius }}
            onPointerDown={dragVideo}
          >
            {/* Two elements on one source — see playback-engine.ts. */}
            <video
              ref={videoA}
              src={videoUrl}
              playsInline
              preload="auto"
              className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              style={{ opacity: 1 }}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) {
                  setSourceAspect(v.videoWidth / v.videoHeight);
                  engine.seek(engine.snapshot().outSec);
                }
              }}
            />
            <video
              ref={videoB}
              src={videoUrl}
              playsInline
              preload="auto"
              className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              style={{ opacity: 0 }}
            />
          </div>

          {/* Hook + captions belong to the EDIT. Over footage that isn't in
              the edit they'd be a lie (captions don't even exist for it), so
              they fade back while previewing. */}
          <div
            className={cn("transition-opacity duration-200", previewing && "pointer-events-none opacity-20")}
          >
          {guides.map((g, i) =>
            g.axis === "y" ? (
              <div key={i} className="pointer-events-none absolute left-0" style={{ top: g.at - 1, width: W, height: 2, background: "#EC4899" }} />
            ) : (
              <div key={i} className="pointer-events-none absolute top-0" style={{ left: g.at - 1, height: H, width: 2, background: "#EC4899" }} />
            ),
          )}
          {/* Images sit between the video and the text — the same order the
              exporter overlays them. */}
          {plan.imageLayers.map((layer) => {
            const rect = imageRect(layer);
            const selected = selection?.kind === "layer" && selection.id === layer.id;
            return (
              <div
                key={layer.id}
                data-image-layer={layer.id}
                className={cn("absolute cursor-grab active:cursor-grabbing", selected && "outline-dashed outline-[6px] outline-sky-400")}
                style={{ left: rect.x, top: rect.y, width: rect.w, opacity: layer.opacity }}
                onPointerDown={(e) => dragImage(e, layer)}
              >
                {imageUrls[layer.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrls[layer.id]}
                    alt=""
                    draggable={false}
                    className="block h-auto w-full select-none"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      if (img.naturalWidth && img.naturalHeight) setImageAspect((m) => ({ ...m, [layer.id]: img.naturalWidth / img.naturalHeight }));
                    }}
                  />
                ) : (
                  <div className="aspect-square w-full bg-white/20" />
                )}
                {selected && (
                  <div
                    onPointerDown={(e) => resizeImage(e, layer)}
                    className="absolute -bottom-3 -right-3 size-6 cursor-nwse-resize rounded-full border-4 border-sky-400 bg-white"
                    style={{ transform: `scale(${1 / Math.max(scale, 0.05)})`, transformOrigin: "center" }}
                  />
                )}
              </div>
            );
          })}
          {scene.textBlocks.map((block) => {
            const rect = textRect(block.layer, block.layout);
            const layer = block.layer;
            return (
            <TextBlock
              key={layer.id}
              id={layer.id}
              rect={rect}
              scale={scale}
              selected={selection?.kind === "layer" && selection.id === layer.id}
              onPointerDown={(e) => dragText(e, layer, rect)}
              onDoubleClick={() => focusLayerText(layer.id)}
              handles={layer.fitHeightPct == null ? SIDE_AND_CORNER_HANDLES : HANDLES}
              onHandleDown={(e, h) => resizeText(e, layer, rect, h)}
            >
              {block.layout.lines.map((line, i) => (
                <LineBox key={`box-${i}`} style={block.layer.style} layout={block.layout} line={line} />
              ))}
              {block.layout.lines.map((line, i) => (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: line.x,
                    top: line.topY,
                    ...textCss(block.layer.style, block.layout),
                  }}
                >
                  {line.text}
                </div>
              ))}
            </TextBlock>
            );
          })}

          {scene.captions && (
            <CaptionOverlay
              scene={scene}
              engine={engine}
              selected={
                selection?.kind === "layer" && selection.id === scene.captions.layer.id
              }
              scale={scale}
              onDragStart={(e, rect) => dragText(e, scene.captions!.layer, rect)}
            />
          )}
          </div>
        </div>
        {isPreview && <PreviewControls engine={engine} />}
        {/* Add things: a line of text, or a logo from the brand's library. */}
        {!isPreview && (<>
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={addText}
            title="Add a line of text"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <TypeIcon className="size-3" /> Text
          </button>
          <LogoPicker
            brand={brand}
            onPick={addImage}
            trigger={
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                <ImageIcon className="size-3" /> Logo
              </span>
            }
          />
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); const next = !snapOn; setSnapOn(next); writeSnapEnabled(next); }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Snap the hook and captions to the centre, thirds and the video's edges while dragging (hold ⌥ to drag freely)"
          className={cn("absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", snapOn ? "border-pink-300 bg-pink-50 text-pink-800" : "border-border bg-background/90 text-muted-foreground")}
        >
          <MagnetIcon className="size-3" /> Snap
        </button>
        </>)}
        {previewing && !isPreview && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-amber-400 px-3 py-1 text-[11px] font-semibold text-black shadow">
              Previewing source · not in your clip
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Post tab's player chrome, over the finished clip: click anywhere to
 * play/pause, a thin scrub bar along the bottom. Subscribes to the engine
 * itself so only this re-renders on playback.
 */
function PreviewControls({ engine }: { engine: PlaybackEngine }) {
  const [snap, setSnap] = useState(() => engine.snapshot());
  useEffect(() => engine.subscribe(setSnap), [engine]);
  // The Post tab shows the clip, never a source preview left over from the Clip tab.
  useEffect(() => {
    if (engine.snapshot().mode === "preview") engine.exitPreview();
  }, [engine]);
  const pct = snap.durationSec > 0 ? (snap.outSec / snap.durationSec) * 100 : 0;
  return (
    <div className="group/player absolute inset-0 z-10">
      <button type="button" aria-label={snap.playing ? "Pause" : "Play clip"} onClick={() => engine.toggle()} className="absolute inset-0 flex items-center justify-center">
        {!snap.playing && (
          <span className="flex size-14 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm">
            <PlayIcon className="size-6 translate-x-0.5" fill="currentColor" />
          </span>
        )}
      </button>
      <div className={cn("absolute inset-x-0 bottom-0 px-3 pb-2 pt-6 transition-opacity", snap.playing && "opacity-0 group-hover/player:opacity-100")} style={{ background: "linear-gradient(transparent, rgba(0,0,0,0.45))" }}>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(0.1, snap.durationSec)}
          step={0.01}
          value={Math.min(snap.outSec, snap.durationSec)}
          onChange={(e) => engine.seek(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-white"
          style={{ background: `linear-gradient(to right, #fff ${pct}%, rgba(255,255,255,0.35) ${pct}%)` }}
        />
      </div>
    </div>
  );
}

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const SIDE_AND_CORNER_HANDLES: Handle[] = ["nw", "ne", "e", "se", "sw", "w"];

/** Double-click on the stage → type in the layer's text field. */
function focusLayerText(id: string) {
  const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-text-layer="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "nearest" });
  el.focus();
  el.select();
}

/** Draggable hit-area around a text block, with resize handles when
 *  selected. `rect` is in canvas px; the grab margin and handles are sized
 *  in SCREEN px (÷ scale) so they stay easy to hit on a small preview. */
function TextBlock({
  id,
  rect,
  scale,
  selected,
  onPointerDown,
  onDoubleClick,
  handles = [],
  onHandleDown,
  children,
}: {
  id?: string;
  rect: Rect;
  scale: number;
  selected: boolean;
  onPointerDown: (e: PointerEvent) => void;
  onDoubleClick?: () => void;
  handles?: Handle[];
  onHandleDown?: (e: PointerEvent, h: Handle) => void;
  children: React.ReactNode;
}) {
  const k = 1 / Math.max(scale, 0.05);
  const pad = 8 * k;
  const w = Math.max(rect.w, 40 * k);
  const left = rect.x + rect.w / 2 - w / 2;
  const box = { left: left - pad, top: rect.y - pad, width: w + pad * 2, height: rect.h + pad * 2 };
  const hs = 12 * k;
  return (
    <>
      {children}
      <div
        className={cn(
          "absolute cursor-grab rounded-md active:cursor-grabbing hover:outline-dashed hover:outline-sky-400/60",
          selected && "outline-dashed outline-sky-400",
        )}
        data-text-block={id}
        style={{ ...box, outlineWidth: (selected ? 2 : 1.5) * k }}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      />
      {selected &&
        onHandleDown &&
        handles.map((h) => {
          const cx = h.includes("w") ? box.left : h.includes("e") ? box.left + box.width : box.left + box.width / 2;
          const cy = h.startsWith("n") ? box.top : h.startsWith("s") ? box.top + box.height : box.top + box.height / 2;
          const side = h === "e" || h === "w";
          const tb = h === "n" || h === "s";
          return (
            <div
              key={h}
              data-handle={h}
              onPointerDown={(e) => onHandleDown(e, h)}
              className="absolute rounded-full border-sky-500 bg-white shadow"
              style={{
                left: cx - (side ? hs / 3 : tb ? hs : hs / 2),
                top: cy - (tb ? hs / 3 : side ? hs : hs / 2),
                width: side ? (hs * 2) / 3 : tb ? hs * 2 : hs,
                height: tb ? (hs * 2) / 3 : side ? hs * 2 : hs,
                borderWidth: 2 * k,
                cursor: side ? "ew-resize" : tb ? "ns-resize" : h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
              }}
            />
          );
        })}
    </>
  );
}

/**
 * Captions change several times a second, so this component subscribes to
 * the engine clock itself and only re-renders when the visible cue or the
 * highlighted word actually changes — the rest of the editor never re-renders
 * on playback.
 */
function CaptionOverlay({
  scene,
  engine,
  selected,
  scale,
  onDragStart,
}: {
  scene: Scene;
  engine: PlaybackEngine;
  selected: boolean;
  scale: number;
  onDragStart: (e: PointerEvent, rect: Rect) => void;
}) {
  const [active, setActive] = useState<{ cue: number; word: number } | null>(null);
  const captions = scene.captions!;

  useEffect(() => {
    return engine.subscribe((snap) => {
      const hit = activeCaptionAt(scene, snap.outSec);
      const next = hit
        ? { cue: captions.cues.indexOf(hit.cue), word: hit.activeWord }
        : null;
      setActive((prev) =>
        prev?.cue === next?.cue && prev?.word === next?.word ? prev : next,
      );
    });
  }, [engine, scene, captions]);

  const cue = active ? captions.cues[active.cue] : null;
  // With nothing on screen, still give the user something to grab: a ghost
  // of the first cue marks where captions will appear.
  const shown = cue ?? captions.cues[0];
  if (!shown) return null;
  const { layer } = captions;
  const ghost = !cue;

  return (
    <TextBlock
      rect={{ x: shown.layout.left, y: shown.layout.top, w: shown.layout.right - shown.layout.left, h: shown.layout.bottom - shown.layout.top }}
      scale={scale}
      selected={selected}
      onPointerDown={(e) => onDragStart(e, { x: shown.layout.left, y: shown.layout.top, w: shown.layout.right - shown.layout.left, h: shown.layout.bottom - shown.layout.top })}
    >
      {shown.layout.lines.map((line, i) => (
        <LineBox key={`box-${i}`} style={layer.style} layout={shown.layout} line={line} opacity={ghost ? (selected ? 0.35 : 0) : 1} />
      ))}
      {shown.layout.lines.map((line, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            left: line.x,
            top: line.topY,
            ...textCss(layer.style, shown.layout),
            opacity: ghost ? (selected ? 0.35 : 0) : 1,
          }}
        >
          {line.words.map((w, wi) => (
            <span
              key={wi}
              style={
                !ghost && layer.highlightColor && w.ref === active?.word
                  ? { color: layer.highlightColor }
                  : undefined
              }
            >
              {wi > 0 ? " " : ""}
              {w.text}
            </span>
          ))}
        </div>
      ))}
    </TextBlock>
  );
}
