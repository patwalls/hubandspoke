// "Upload examples" → a starting clip LOOK. The Skill builder's AI reads the
// example screenshots and reports what it SEES about the frame (shape,
// background) and the two text layers (font family, colour, outline / box /
// clean, caps, where they sit). This turns that report into a real ClipLook
// on top of the default layout, so the clip look editor opens already
// resembling the examples. Pure: the model's guess is clamped to the editor's
// own fonts, presets and positions, and the result is validated.
import { z } from "zod";
import {
  FONT_IDS,
  TEXT_STYLE_PRESETS,
  clipLookSchema,
  createDefaultDoc,
  lookFromDoc,
  type ClipLook,
  type TextStyle,
} from "./doc";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const position = z.enum(["top", "middle", "bottom"]);
const textLook = z.object({
  present: z.boolean(),
  fontId: z.enum(FONT_IDS).optional(),
  color: hex.optional(),
  style: z.enum(["clean", "outline", "boxed"]).optional(),
  boxColor: hex.optional(),
  uppercase: z.boolean().optional(),
  position: position.optional(),
});

/** What the AI reports about the examples (the build-skill tool's
 *  `look` field). Every part optional — it says what it can see. */
export const lookSuggestionSchema = z.object({
  aspectRatio: z.enum(["9:16", "16:9"]),
  background: hex.optional(),
  hook: textLook.optional(),
  captions: textLook.extend({ highlightColor: hex.nullable().optional(), wordsPerCue: z.number().int().min(1).max(8).optional() }).optional(),
});
export type LookSuggestion = z.infer<typeof lookSuggestionSchema>;

type TextLook = z.infer<typeof textLook>;

function styled(base: TextStyle, t: TextLook | undefined): TextStyle {
  if (!t) return base;
  const preset = t.style ? TEXT_STYLE_PRESETS[t.style].patch : null;
  return {
    ...base,
    ...(t.fontId ? { fontId: t.fontId } : {}),
    ...(t.color ? { color: t.color.toUpperCase() } : {}),
    ...(t.uppercase !== undefined ? { uppercase: t.uppercase } : {}),
    ...(preset ? { outlinePct: preset.outlinePct, shadow: preset.shadow, box: preset.box } : {}),
    ...(t.style === "boxed" && t.boxColor && preset?.box ? { box: { ...preset.box, color: t.boxColor.toUpperCase() } } : {}),
  };
}

/** Where each position puts a layer, per shape (default layout's values
 *  for the usual spot). */
const HOOK_Y: Record<"9:16" | "16:9", Record<"top" | "middle" | "bottom", { yPct: number; anchor: "top" | "center" | "bottom" }>> = {
  "9:16": { top: { yPct: 31, anchor: "bottom" }, middle: { yPct: 50, anchor: "center" }, bottom: { yPct: 88, anchor: "bottom" } },
  "16:9": { top: { yPct: 14, anchor: "center" }, middle: { yPct: 50, anchor: "center" }, bottom: { yPct: 86, anchor: "center" } },
};
const CAPTIONS_Y: Record<"9:16" | "16:9", Record<"top" | "middle" | "bottom", { yPct: number; anchor: "top" | "center" | "bottom" }>> = {
  "9:16": { top: { yPct: 18, anchor: "top" }, middle: { yPct: 55, anchor: "center" }, bottom: { yPct: 69, anchor: "top" } },
  "16:9": { top: { yPct: 16, anchor: "center" }, middle: { yPct: 55, anchor: "center" }, bottom: { yPct: 84, anchor: "center" } },
};

/** A ClipLook resembling the examples, or null if the suggestion is unusable. */
export function lookFromSuggestion(raw: unknown): { look: ClipLook; aspectRatio: "9:16" | "16:9" } | null {
  const parsed = lookSuggestionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const aspect = s.aspectRatio;
  const doc = createDefaultDoc({ startSec: 0, endSec: 10, hook: "Your hook goes here — every clip gets its own", aspectRatio: aspect });
  const layers = doc.layers.map((l) => {
    if (l.type === "text" && l.role === "hook") {
      const t = s.hook;
      return {
        ...l,
        visible: t ? t.present : l.visible,
        ...(t?.position ? HOOK_Y[aspect][t.position] : {}),
        style: styled(l.style, t),
      };
    }
    if (l.type === "captions") {
      const c = s.captions;
      return {
        ...l,
        visible: c ? c.present : l.visible,
        ...(c?.position ? CAPTIONS_Y[aspect][c.position] : {}),
        style: styled(l.style, c),
        ...(c?.highlightColor !== undefined ? { highlightColor: c.highlightColor ? c.highlightColor.toUpperCase() : null } : {}),
        ...(c?.wordsPerCue ? { maxWordsPerCue: c.wordsPerCue, maxCharsPerCue: Math.min(120, Math.max(4, c.wordsPerCue * 7)) } : {}),
      };
    }
    return l;
  });
  const look = lookFromDoc({ ...doc, canvas: { ...doc.canvas, background: s.background?.toUpperCase() ?? doc.canvas.background }, layers });
  const valid = clipLookSchema.safeParse(look);
  return valid.success ? { look: valid.data, aspectRatio: aspect } : null;
}

/** One line for the UI: what was matched. */
export function describeLookSuggestion(s: LookSuggestion): string {
  const parts = [s.aspectRatio === "16:9" ? "horizontal 16:9" : "vertical 9:16"];
  if (s.hook?.present === false) parts.push("no hook text");
  else if (s.hook?.style) parts.push(`${s.hook.style} hook`);
  if (s.captions?.present === false) parts.push("no captions");
  else if (s.captions?.style) parts.push(`${s.captions.style} captions${s.captions.highlightColor ? " with a highlight colour" : ""}`);
  return parts.join(" · ");
}
