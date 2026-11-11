/**
 * "Enhance" for a picture in the design editor — the Canva-style AI upscale.
 * The worker (`design-enhance`) sends the picture to OpenAI's gpt-image-2
 * edit endpoint, which redraws it at ~2048px with clean detail, and stores
 * the result in the source video's photo library (`design_photos` kind
 * `enhanced`). Pure helpers live here so the client and the worker agree.
 *
 * Why gpt-image-2 (tested 2026-11-10 on 640×360 and 1920×1080 founder
 * frames against gpt-image-1.5, chatgpt-image-latest, gpt-image-2.6-sunburst):
 * it kept the face, glasses, framing and on-screen logos the closest while
 * being the crispest; chatgpt-image-latest changed eye colour, 1.5 reframed
 * the shot, sunburst re-lit and nudged the subject. It also accepts any
 * size in multiples of 16, so the output keeps the picture's own shape.
 */
import type { ImageSource } from "@/lib/editor/image-source";
import { imageSourceKey } from "@/lib/editor/image-source";

export const ENHANCE_MODEL = "gpt-image-2";

/** Longest side of the enhanced picture. ~4× a 640px video frame, ~2× a
 *  1080p one — plenty for a 1080-wide post even zoomed in 2×. */
export const ENHANCE_LONG_SIDE = 2048;

/** gpt-image-2's size rules: both sides multiples of 16, ratio ≤ 3:1. */
const STEP = 16;
const MAX_RATIO = 3;

/** The `size` to ask for: the input's aspect at a ~2048px long side,
 *  snapped to 16px. Extreme panoramas are clamped to 3:1. */
export function enhanceOutputSize(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: ENHANCE_LONG_SIDE, height: ENHANCE_LONG_SIDE };
  let ratio = width / height;
  ratio = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, ratio));
  const snap = (v: number) => Math.max(STEP, Math.round(v / STEP) * STEP);
  return ratio >= 1
    ? { width: ENHANCE_LONG_SIDE, height: snap(ENHANCE_LONG_SIDE / ratio) }
    : { width: snap(ENHANCE_LONG_SIDE * ratio), height: ENHANCE_LONG_SIDE };
}

const BASE_PROMPT =
  "Enhance this photo into a crisp, high-resolution professional photograph: sharpen detail, " +
  "remove compression artifacts, blur and noise, and improve lighting and color like a high-end camera. " +
  "Keep the person's face, identity, expression, pose, hair, glasses, clothing, and the entire " +
  "composition and framing EXACTLY the same. Do not add, remove or move anything. " +
  "Keep all text, logos and screens as they are.";

const BLUR_PROMPT =
  " Then give it a shallow depth of field like a full-frame camera with a fast portrait lens: " +
  "the person stays tack sharp and the background gets a soft, natural blur (bokeh).";

export function enhancePrompt(blur: boolean): string {
  return blur ? BASE_PROMPT + BLUR_PROMPT : BASE_PROMPT;
}

/** Identity of one enhancement: the picture + whether the background was
 *  blurred. Stored as `design_photos.source_key`, so the same picture
 *  enhanced the same way is made once and reused. */
export function enhanceSourceKey(src: ImageSource, blur: boolean): string {
  return `${imageSourceKey(src)}${blur ? "#enhance-blur" : "#enhance"}`;
}

/** Pictures that can be enhanced: stored or public https ones (logos under
 *  /public are not photos). */
export function canEnhance(src: ImageSource): boolean {
  return src.kind === "s3" || (src.kind === "url" && src.url.startsWith("https://"));
}
