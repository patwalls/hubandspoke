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
import { imageSourceSchema, type ImageSource } from "@/lib/editor/image-source";

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

/**
 * A slot marks an element a FORMAT TEMPLATE wants filled per post (see
 * template-fill.ts). `ai` = the model writes it from the transcript (the
 * hint tells it what); the others are filled from the item itself —
 * `photo` is THE founder picture (the filmstrip's pick), `frame` is a
 * different still of the video per slot, in library order, for story
 * slides that each want their own picture. Static
 * elements (logos, pills, the Notes chrome) have no slot. Slots survive into
 * the item's document so the editor can still tell what an element was.
 */
export const SLOT_KINDS = ["ai", "photo", "frame", "videoTitle", "channelName", "channelSubscribers", "dmKeyword"] as const;
/** In a `dmKeyword` text slot, this token becomes the post's attached
 *  ManyChat keyword ("BOOTSTRAP"). Structural placeholder, not content. */
export const DM_KEYWORD_TOKEN = "{{keyword}}";
const slotSchema = z.object({
  kind: z.enum(SLOT_KINDS),
  /** For `ai`: what to write ("the founder's biggest revenue number"). */
  hint: z.string().max(800),
});
export type DesignSlot = z.infer<typeof slotSchema>;

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
  slot: slotSchema.nullable().default(null),
  /** Elements sharing a stack key on a page flow top-to-bottom after a
   *  template is filled (gaps kept from the template, text heights from the
   *  layout, the whole stack shrunk to fit the page). How the Notes page
   *  survives a 3-phase vs 5-phase playbook. */
  stack: z.string().max(40).nullable().default(null),
};

const textElementSchema = z.object({
  ...elementBase,
  type: z.literal("text"),
  spans: z.array(spanSchema).min(1).max(50),
  style: textStyleSchema,
});
export type DesignTextElement = z.infer<typeof textElementSchema>;

export type DesignImageSource = ImageSource;

/** How a `cover`-fitted picture sits in its box: the focal point (0–1 of the
 *  picture's own width/height) that stays centred, and extra zoom on top of
 *  the cover scale. `{0.5, 0.5, 1}` is plain object-fit: cover. Ignored for
 *  `contain`. Geometry in layout.ts → `coverGeometry`. */
const cropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(4),
});
export type DesignCrop = z.infer<typeof cropSchema>;
export const DEFAULT_CROP: DesignCrop = { x: 0.5, y: 0.5, zoom: 1 };

const imageElementSchema = z.object({
  ...elementBase,
  type: z.literal("image"),
  src: imageSourceSchema,
  fit: z.enum(["cover", "contain"]),
  radius: px.min(0),
  crop: cropSchema.default(DEFAULT_CROP),
});
export type DesignImageElement = z.infer<typeof imageElementSchema>;

/** A clip of the source video. A page with one of these is a VIDEO slide:
 *  the exporter renders it as an mp4 whose length is `endSec - startSec`,
 *  with everything below it in z-order baked under the footage and
 *  everything above it baked over. One per page. */
const videoElementSchema = z.object({
  ...elementBase,
  type: z.literal("video"),
  /** null only inside a format template (no source yet); a filled item
   *  document always has one. */
  src: z.object({ kind: z.literal("s3"), bucket: z.string().nullable(), key: z.string().min(1) }).nullable(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  fit: z.enum(["cover", "contain"]),
  radius: px.min(0),
  crop: cropSchema.default(DEFAULT_CROP),
});
export type DesignVideoElement = z.infer<typeof videoElementSchema>;

/** Rolling transcript captions for the page's video: shows what is being
 *  said, cue by cue, in this box and style. Text comes from the transcript
 *  at render time (never stored) — see captions.ts. */
const captionsElementSchema = z.object({
  ...elementBase,
  type: z.literal("captions"),
  style: textStyleSchema,
  /** Longest cue before it splits (sentences split at punctuation anyway). */
  maxWordsPerCue: z.number().int().min(2).max(30),
});
export type DesignCaptionsElement = z.infer<typeof captionsElementSchema>;

const rectElementSchema = z.object({
  ...elementBase,
  type: z.literal("rect"),
  fill: rgbaSchema,
  /** Optional gradient: `fill` at one end → `gradientTo` at the other. How
   *  a cover darkens toward its headline: fill transparent, gradientTo black. */
  gradientTo: rgbaSchema.nullable(),
  /** Which way the gradient runs: "down" = fill at the top, gradientTo at
   *  the bottom (a shade under a headline); "up" the reverse (under a title
   *  at the top). */
  gradientDirection: z.enum(["down", "up"]).default("down"),
  radius: px.min(0),
});
export type DesignRectElement = z.infer<typeof rectElementSchema>;

/**
 * The shade every photo cover needs so white text reads over it: clear at
 * one end, near-black at the other, over the part of the picture the text
 * sits on. Add it right above the photo in z-order, under the text.
 */
export function shadeElement(canvas: { width: number; height: number }, where: "bottom" | "top" = "bottom"): DesignRectElement {
  const h = Math.round(canvas.height * 0.62);
  return {
    id: newElementId("r"), name: where === "bottom" ? "Shade" : "Shade (top)", type: "rect",
    x: 0, y: where === "bottom" ? canvas.height - h : 0, w: canvas.width, h, opacity: 1, locked: false, slot: null, stack: null,
    fill: { color: "#000000", alpha: 0 }, gradientTo: { color: "#000000", alpha: 0.92 }, gradientDirection: where === "bottom" ? "down" : "up", radius: 0,
  };
}

/**
 * The brand's channel, drawn from `accounts` at preview and render time:
 * avatar, display name (✓ when verified), follower count. Nothing about the
 * account is stored in the document — pick the account (or just a platform
 * and the brand's account for it is used) and the numbers stay live.
 * The box's HEIGHT sets the avatar size; the width is the room for the name.
 */
const channelElementSchema = z.object({
  ...elementBase,
  type: z.literal("channel"),
  /** A specific `accounts.id`, or null → the brand's account on `platform`. */
  accountId: z.string().nullable(),
  platform: z.enum(["youtube", "instagram", "x", "tiktok", "linkedin", "threads"]),
  showFollowers: z.boolean(),
  /** Text colours: dark text on light pages, light text on dark ones. */
  theme: z.enum(["light", "dark"]),
});
export type DesignChannelElement = z.infer<typeof channelElementSchema>;

/** Discriminated on `type`; array order = z-order, last on top. */
export const designElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  rectElementSchema,
  videoElementSchema,
  captionsElementSchema,
  channelElementSchema,
]);
export type DesignElement = z.infer<typeof designElementSchema>;

const pageSchema = z.object({
  id: z.string().min(1),
  background: hexColor,
  elements: z
    .array(designElementSchema)
    .max(100)
    .refine((els) => els.filter((e) => e.type === "video").length <= 1, { message: "A page can hold one video" }),
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

/** Shown in a photo slot until a real picture is chosen. */
export const PHOTO_PLACEHOLDER: DesignImageSource = { kind: "asset", path: "/design/photo-placeholder.png" };

export function isPhotoPlaceholder(src: DesignImageSource): boolean {
  return src.kind === "asset" && src.path === (PHOTO_PLACEHOLDER as { path: string }).path;
}

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

/** The clip a page plays, if it is a video slide. */
export function pageVideo(page: DesignPage): DesignVideoElement | null {
  for (const el of page.elements) if (el.type === "video") return el;
  return null;
}

export function pageDurationSec(page: DesignPage): number {
  const v = pageVideo(page);
  return v ? Math.max(0, v.endSec - v.startSec) : 0;
}

export function spansToText(spans: DesignSpan[]): string {
  return spans.map((s) => s.text).join("");
}

let seq = 0;
export function newElementId(prefix = "el"): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}
