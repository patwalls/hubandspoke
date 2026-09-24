/**
 * resolveScene — lay out every text element of a plan in canvas pixels.
 *
 * This is the last shared step before the renderers diverge: the React stage
 * draws these lines as absolutely-positioned divs, the exporter writes them
 * as ASS events. Neither does any layout of its own (see layout.ts).
 */
import type { CaptionsLayer, TextLayer } from "./doc";
import {
  fitTextSizePct,
  layoutTextBlock,
  textToLayoutWords,
  type TextBlockLayout,
} from "./layout";
import type { CaptionCue, RenderPlan } from "./plan";

/** Captions have no user-set width; keep them off the canvas edges. */
const CAPTIONS_WIDTH_PCT = 90;

export interface SceneTextBlock {
  layer: TextLayer;
  layout: TextBlockLayout;
}

export interface SceneCaptionCue {
  cue: CaptionCue;
  /** `ref` on each laid-out word is its index in `cue.words`. */
  layout: TextBlockLayout;
}

export interface Scene {
  textBlocks: SceneTextBlock[];
  captions: { layer: CaptionsLayer; cues: SceneCaptionCue[] } | null;
}

/** Shrink to fit: the layer's size, or the largest smaller one at which the
 *  block fits its box. Here (not in the stage) so preview and export agree. */
export function fittedStyle(layer: TextLayer, canvas: { width: number; height: number }): TextLayer["style"] {
  if (layer.fitHeightPct == null) return layer.style;
  const sizePct = fitTextSizePct({ text: layer.text, style: layer.style, canvas, widthPct: layer.widthPct, maxHeightPct: layer.fitHeightPct, minSizePct: 0.5 });
  return sizePct === layer.style.sizePct ? layer.style : { ...layer.style, sizePct };
}

export function resolveScene(plan: RenderPlan): Scene {
  const textBlocks = plan.textLayers.map((layer) => ({
    layer,
    layout: layoutTextBlock({
      words: textToLayoutWords(layer.text),
      style: fittedStyle(layer, plan.canvas),
      canvas: plan.canvas,
      xPct: layer.xPct,
      yPct: layer.yPct,
      anchor: layer.anchor,
      widthPct: layer.widthPct,
      balance: true,
    }),
  }));

  const captions = plan.captions
    ? {
        layer: plan.captions.layer,
        cues: plan.captions.cues.map((cue) => ({
          cue,
          layout: layoutTextBlock({
            words: cue.words.map((w, i) => ({ text: w.text, ref: i })),
            style: plan.captions!.layer.style,
            canvas: plan.canvas,
            xPct: plan.captions!.layer.xPct,
            yPct: plan.captions!.layer.yPct,
            anchor: plan.captions!.layer.anchor,
            widthPct: CAPTIONS_WIDTH_PCT,
            balance: false,
          }),
        })),
      }
    : null;

  return { textBlocks, captions };
}

/** The caption cue on screen at output time `t`, and which word is lit. */
export function activeCaptionAt(
  scene: Scene,
  outSec: number,
): { cue: SceneCaptionCue; activeWord: number } | null {
  if (!scene.captions) return null;
  for (const c of scene.captions.cues) {
    if (outSec < c.cue.outStartSec) return null; // cues are sorted
    if (outSec >= c.cue.outEndSec) continue;
    let activeWord = 0;
    c.cue.words.forEach((w, i) => {
      if (outSec >= w.outStartSec) activeWord = i;
    });
    return { cue: c, activeWord };
  }
  return null;
}
