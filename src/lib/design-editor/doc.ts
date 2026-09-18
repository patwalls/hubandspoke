/**
 * The design document — a multi-page image post (an Instagram carousel), the
 * design-editor counterpart of the clip editor's ClipEditDoc.
 *
 * Same architecture, same reasons (see src/lib/clip-editor/doc.ts): the doc
 * stores intent in canvas pixels; text is laid out ONCE by layout.ts into
 * explicit lines; the browser stage and the satori/resvg exporter both draw
 * those lines. Coordinates are canvas pixels (the canvas is a fixed logical
 * size, 1080 wide), so "move it 40px right" means the same thing everywhere.
 *
 * The AI never edits this document directly. It produces a BRIEF (content:
 * the stat, the headline, the phases…) and a template turns the brief into
 * a doc (playbook-template.ts). After that the doc belongs to the editor.
 */
import { z } from "zod";
import { FONT_IDS } from "@/lib/clip-editor/doc";

export const DESIGN_DOC_VERSION = 1;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const px = z.number().finite();

/** A colour with alpha, for overlays/shadows: #RRGGBB + 0–1. */
const rgbaSchema = z.object({ color: hexColor, alpha: z.number().min(0).max(1) });
export type Rgba = z.infer<typeof rgbaSchema>;

const textStyleSchema = z.object({
  fontId: z.enum(FONT_IDS),
  sizePx: px.min(8).max(600),
  /** Line pitch as a multiple of the font size. */
  lineHeight: z.number().min(0.7).max(3),
  color: hexColor,
  align: z.enum(["left", "center", "right"]),
  valign: z.enum(["top", "middle", "bottom"]),
  uppercase: z.boolean(),
  /** Drop shadow — the Playbook headline's black glow. */
  shadow: z
    .object({ color: hexColor, alpha: z.number().min(0).max(1), blur: px.min(0), x: px, y: px })
    .nullable(),
  /** Shrink the font (down to `minSizePx`) until the text fits the box. */
  autoFit: z.boolean(),
  minSizePx: px.min(8).max(600),
});
export type DesignTextStyle = z.infer<typeof textStyleSchema>;

/** Text is a list of spans so a phrase can be highlighted ("$69K/MONTH SAAS"
 *  in green) without becoming a separate element. `\n` inside a span is a
 *  hard line break. */
const spanSchema = z.object({ text: z.string().max(2000), color: hexColor.optional() });
export type DesignSpan = z.infer<typeof spanSchema>;

const elementBase = {
  id: z.string().min(1),
  /** Editor label ("Headline", "Stat") — what the AI slot was; never shown
   *  in the export. */
  name: z.string().max(60),
  x: px,
  y: px,
  w: px.min(1),
  h: px.min(1),
  opacity: z.number().min(0).max(1),
  locked: z.boolean(),
};

const textElementSchema = z.object({
  ...elementBase,
  type: z.literal("text"),
  spans: z.array(spanSchema).min(1).max(50),
  style: textStyleSchema,
});
export type DesignTextElement = z.infer<typeof textElementSchema>;

const imageSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url().max(2000) }),
  z.object({ kind: z.literal("s3"), bucket: z.string().nullable(), key: z.string().min(1) }),
  /** A file under public/ (brand logos, watermarks) — "/watermarks/x.png". */
  z.object({ kind: z.literal("asset"), path: z.string().regex(/^\/[a-zA-Z0-9_\-./]+$/) }),
]);
export type DesignImageSource = z.infer<typeof imageSourceSchema>;

const imageElementSchema = z.object({
  ...elementBase,
  type: z.literal("image"),
  src: imageSourceSchema,
  fit: z.enum(["cover", "contain"]),
  radius: px.min(0),
});
export type DesignImageElement = z.infer<typeof imageElementSchema>;

const rectElementSchema = z.object({
  ...elementBase,
  type: z.literal("rect"),
  fill: rgbaSchema,
  /** Optional vertical gradient: fill at the top → `gradientTo` at the bottom.
   *  How the cover darkens toward the headline. */
  gradientTo: rgbaSchema.nullable(),
  radius: px.min(0),
});
export type DesignRectElement = z.infer<typeof rectElementSchema>;

/** Discriminated on `type`; array order = z-order, last on top. */
export const designElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  rectElementSchema,
]);
export type DesignElement = z.infer<typeof designElementSchema>;

const pageSchema = z.object({
  id: z.string().min(1),
  background: hexColor,
  elements: z.array(designElementSchema).max(100),
});
export type DesignPage = z.infer<typeof pageSchema>;

export const designDocSchema = z.object({
  version: z.literal(DESIGN_DOC_VERSION),
  canvas: z.object({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(320).max(4096),
  }),
  pages: z.array(pageSchema).min(1).max(20),
  /** Which template built this (for "regenerate" and for the editor's
   *  sense of what the slots were). */
  template: z.string().max(40),
});
export type DesignDoc = z.infer<typeof designDocSchema>;

export const IG_SQUARE = { width: 1080, height: 1080 } as const;

export function parseDesignDoc(
  raw: unknown,
): { ok: true; doc: DesignDoc } | { ok: false; error: string } {
  const result = designDocSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `Invalid design document at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}`,
    };
  }
  return { ok: true, doc: result.data };
}

export function spansToText(spans: DesignSpan[]): string {
  return spans.map((s) => s.text).join("");
}

let seq = 0;
export function newElementId(prefix = "el"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}
