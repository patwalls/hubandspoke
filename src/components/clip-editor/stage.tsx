"use client";

/**
 * The stage — a live, WYSIWYG preview of the export.
 *
 * It draws the canvas at its TRUE pixel size (e.g. 1080×1920) inside a
 * CSS-scaled wrapper, so every coordinate here is a canvas pixel — the exact
 * numbers layout.ts produced and the exact numbers the ASS script hands to
 * libass. No second set of "preview" math to drift out of sync with export.
 *
 * Everything on the stage can be dragged: hook and captions vertically, the
 * video vertically (fit) or horizontally (fill). Drags go through the store's
 * `apply` with a coalesce key, so one drag = one undo step.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import type { CaptionsLayer, ClipEditDoc, TextLayer, TextStyle } from "@/lib/clip-editor/doc";
import { FONTS, fontFaceCss } from "@/lib/clip-editor/fonts";
import type { TextBlockLayout } from "@/lib/clip-editor/layout";
import type { RenderPlan } from "@/lib/clip-editor/plan";
import { activeCaptionAt, type Scene } from "@/lib/clip-editor/scene";
import type { PlaybackEngine } from "./playback-engine";
import { commands, useEditor } from "./store";

interface StageProps {
  plan: RenderPlan;
  scene: Scene;
  engine: PlaybackEngine;
  videoUrl: string;
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
    whiteSpace: "pre",
    // libass draws the outline OUTSIDE the glyph; a CSS stroke is centered on
    // the edge, so double the width and paint it under the fill to match.
    ...(outlinePx > 0
      ? {
          WebkitTextStroke: `${outlinePx * 2}px ${style.outlineColor}`,
          paintOrder: "stroke fill",
        }
      : {}),
  };
}

export function Stage({ plan, scene, engine, videoUrl }: StageProps) {
  const { width: W, height: H } = plan.canvas;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const videoA = useRef<HTMLVideoElement | null>(null);
  const videoB = useRef<HTMLVideoElement | null>(null);
  const [scale, setScale] = useState(0);
  const [sourceAspect, setSourceAspect] = useState(16 / 9);

  const apply = useEditor((s) => s.apply);
  const selection = useEditor((s) => s.stageSelection);
  const setSelection = useEditor((s) => s.setStageSelection);

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

  // Where the video sits — must match ffmpeg-args.ts (scale + pad | crop).
  const videoBox = useMemo(() => {
    const canvasAspect = W / H;
    if (plan.video.fit === "contain") {
      const wide = sourceAspect > canvasAspect;
      const w = wide ? W : H * sourceAspect;
      const h = wide ? W / sourceAspect : H;
      const top = Math.max(0, Math.min(H - h, (H * plan.video.yPct) / 100 - h / 2));
      return { left: (W - w) / 2, top, width: w, height: h };
    }
    const wide = sourceAspect > canvasAspect;
    const w = wide ? H * sourceAspect : W;
    const h = wide ? H : W / sourceAspect;
    return {
      left: -((w - W) * plan.video.panXPct) / 100,
      top: -(h - H) / 2,
      width: w,
      height: h,
    };
  }, [W, H, sourceAspect, plan.video]);

  /** Start a drag that maps pointer movement (in canvas px) to a doc change. */
  const startDrag = (
    e: PointerEvent,
    onMove: (dxCanvas: number, dyCanvas: number) => (doc: ClipEditDoc) => ClipEditDoc,
    coalesceKey: string,
  ) => {
    if (scale === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    // Unique per gesture so two separate drags are two undo steps.
    const key = `${coalesceKey}:${e.timeStamp}`;
    const move = (ev: globalThis.PointerEvent) => {
      apply(onMove((ev.clientX - startX) / scale, (ev.clientY - startY) / scale), key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clampPct = (n: number) => Math.max(0, Math.min(100, n));

  const dragLayerY = (e: PointerEvent, layer: TextLayer | CaptionsLayer) => {
    setSelection({ kind: "layer", id: layer.id });
    const startPct = layer.yPct;
    startDrag(
      e,
      (_dx, dy) =>
        commands.patchLayer(layer.id, (l) => ({
          ...l,
          yPct: clampPct(startPct + (dy / H) * 100),
        })),
      `drag-layer-${layer.id}`,
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

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full w-full items-center justify-center"
      onPointerDown={() => setSelection(null)}
    >
      <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
      <div
        className="relative shrink-0 overflow-hidden rounded-lg shadow-xl ring-1 ring-black/20"
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
              "absolute cursor-grab active:cursor-grabbing",
              selection?.kind === "video" && "outline-dashed outline-[6px] outline-sky-400",
            )}
            style={videoBox}
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

          {scene.textBlocks.map((block) => (
            <TextBlock
              key={block.layer.id}
              layout={block.layout}
              selected={selection?.kind === "layer" && selection.id === block.layer.id}
              onPointerDown={(e) => dragLayerY(e, block.layer)}
            >
              {block.layout.lines.map((line, i) => (
                <div
                  key={i}
                  className="absolute -translate-x-1/2"
                  style={{
                    left: block.layout.centerX,
                    top: line.topY,
                    ...textCss(block.layer.style, block.layout),
                  }}
                >
                  {line.text}
                </div>
              ))}
            </TextBlock>
          ))}

          {scene.captions && (
            <CaptionOverlay
              scene={scene}
              engine={engine}
              selected={
                selection?.kind === "layer" && selection.id === scene.captions.layer.id
              }
              onPointerDown={(e) => dragLayerY(e, scene.captions!.layer)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Draggable hit-area around a laid-out text block. */
function TextBlock({
  layout,
  selected,
  onPointerDown,
  children,
}: {
  layout: TextBlockLayout;
  selected: boolean;
  onPointerDown: (e: PointerEvent) => void;
  children: React.ReactNode;
}) {
  const pad = 16;
  const width = Math.max(layout.widthPx, 120) + pad * 2;
  return (
    <>
      {children}
      <div
        className={cn(
          "absolute cursor-grab rounded-md active:cursor-grabbing hover:outline-dashed hover:outline-[4px] hover:outline-sky-400/60",
          selected && "outline-dashed outline-[6px] outline-sky-400",
        )}
        style={{
          left: layout.centerX - width / 2,
          top: layout.top - pad,
          width,
          height: layout.bottom - layout.top + pad * 2,
        }}
        onPointerDown={onPointerDown}
      />
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
  onPointerDown,
}: {
  scene: Scene;
  engine: PlaybackEngine;
  selected: boolean;
  onPointerDown: (e: PointerEvent) => void;
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
    <TextBlock layout={shown.layout} selected={selected} onPointerDown={onPointerDown}>
      {shown.layout.lines.map((line, i) => (
        <div
          key={i}
          className="absolute -translate-x-1/2"
          style={{
            left: shown.layout.centerX,
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
