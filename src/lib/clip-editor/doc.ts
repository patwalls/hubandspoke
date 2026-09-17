/**
 * The clip edit document — the single source of truth for an in-app clip edit.
 *
 * Architecture (read this before extending the editor):
 *
 *   ClipEditDoc ──compileRenderPlan()──▶ RenderPlan ──▶ browser preview
 *   (editing intent,                    (flat, resolved,   └▶ ffmpeg renderer
 *    persisted as JSON)                  renderer-facing)    └▶ (future) any other renderer
 *
 * The DOC records what the editor *meant*: "this section of the source, minus
 * these removed ranges (and why each was removed), with these overlay layers".
 * It never stores anything derivable — no output timestamps, no caption cues,
 * no pixel positions. That is what makes it safe to evolve: a new renderer, a
 * new caption chunker, or a new canvas size re-derives everything from the
 * same saved doc.
 *
 * The PLAN (plan.ts) is the only thing renderers read. The preview player and
 * the ffmpeg exporter both consume the same plan, which is what keeps "what I
 * see" and "what I export" the same cut. Never teach a renderer to read the
 * doc directly.
 *
 * Coordinates are percentages of the canvas (0–100), sizes are percentages of
 * canvas height, times are seconds on the SOURCE timeline. Nothing in the doc
 * is in pixels or output-time, so the same doc renders at any resolution.
 *
 * Versioning: bump CLIP_EDIT_DOC_VERSION and add a step to `migrateDoc` when
 * the shape changes. Saved docs and render snapshots are migrated on read.
 */
import { z } from "zod";
import { fitTextSizePct } from "./layout";

export const CLIP_EDIT_DOC_VERSION = 1;

// ─── Primitives ─────────────────────────────────────────────────────────────

const sec = z.number().finite().min(0);
const pct = z.number().finite().min(0).max(100);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const timeRangeSchema = z
  .object({ startSec: sec, endSec: sec })
  .refine((r) => r.endSec > r.startSec, "endSec must be after startSec");
export type TimeRange = z.infer<typeof timeRangeSchema>;

/** Why a range was removed. Kept so bulk actions are reversible as a group
 *  ("restore all filler words") and so we can learn from manual edits later. */
export const REMOVAL_REASONS = ["manual", "filler", "silence"] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

const removalSchema = z
  .object({
    startSec: sec,
    endSec: sec,
    reason: z.enum(REMOVAL_REASONS),
  })
  .refine((r) => r.endSec > r.startSec, "endSec must be after startSec");
export type Removal = z.infer<typeof removalSchema>;

/**
 * A contiguous window of the source, minus the ranges removed inside it.
 * Sections play in array order, so reordering footage (e.g. pulling the
 * intro to the top) is just reordering sections.
 */
const sectionSchema = z
  .object({
    id: z.string().min(1),
    /** Informational — drives labels and the "include intro" toggle. */
    role: z.enum(["intro", "body"]),
    startSec: sec,
    endSec: sec,
    /** Sorted, non-overlapping, clamped to the window. See removals.ts. */
    removals: z.array(removalSchema),
  })
  .refine((s) => s.endSec > s.startSec, "endSec must be after startSec");
export type Section = z.infer<typeof sectionSchema>;

// ─── Canvas + video placement ───────────────────────────────────────────────

const canvasSchema = z.object({
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  fps: z.number().int().min(1).max(60),
  background: hexColor,
});
export type Canvas = z.infer<typeof canvasSchema>;

const videoPlacementSchema = z.object({
  /** contain = whole frame visible, letterboxed (never crops a two-shot).
   *  cover = fill the canvas, cropping the overflow. */
  fit: z.enum(["contain", "cover"]),
  /** Vertical center of the video, % of canvas height (contain only). */
  yPct: pct,
  /** Horizontal pan across the cropped overflow, 0 = left … 100 = right
   *  (cover only). */
  panXPct: pct,
  /** Size relative to "fit", 100 = touches the canvas edges; lower insets the
   *  video so the background shows around it (contain only). Defaulted so
   *  docs saved before this field existed still parse. */
  scalePct: z.number().finite().min(30).max(100).default(100),
  /** Corner radius as % of the video's shorter side; 50 = fully round ends
   *  (contain only). */
  radiusPct: z.number().finite().min(0).max(50).default(0),
});
export type VideoPlacement = z.infer<typeof videoPlacementSchema>;

// ─── Overlay layers ─────────────────────────────────────────────────────────

export const FONT_IDS = [
  "montserrat-extrabold",
  "montserrat-bold",
  "poppins-extrabold",
  "poppins-semibold",
  "archivo-black",
  "anton",
  "bebas-neue",
  "bangers",
  "dm-serif-display",
  "permanent-marker",
] as const;
export type FontId = (typeof FONT_IDS)[number];

const textStyleSchema = z.object({
  fontId: z.enum(FONT_IDS),
  /** Font size as % of canvas height — resolution independent. */
  sizePct: z.number().finite().min(0.5).max(20),
  color: hexColor,
  /** Outline thickness as % of font size. 0 = none. */
  outlinePct: z.number().finite().min(0).max(30),
  outlineColor: hexColor,
  uppercase: z.boolean(),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

/** Which edge of the layer's box sits on `yPct`. A hook anchored "bottom"
 *  grows UP as it wraps to more lines, so it never collides with the video
 *  below it; captions anchored "top" grow down. */
const anchorSchema = z.enum(["top", "center", "bottom"]);
export type LayerAnchor = z.infer<typeof anchorSchema>;

const layerBase = {
  id: z.string().min(1),
  visible: z.boolean(),
  /** Horizontal center, % of canvas width. */
  xPct: pct,
  yPct: pct,
  anchor: anchorSchema,
};

const textLayerSchema = z.object({
  ...layerBase,
  type: z.literal("text"),
  /** "hook" marks THE hook so the workflow can find it (title, clip idea
   *  sync). Any other text layer is "generic". */
  role: z.enum(["hook", "generic"]),
  text: z.string().max(500),
  /** Wrap width, % of canvas width. */
  widthPct: z.number().finite().min(10).max(100),
  style: textStyleSchema,
});
export type TextLayer = z.infer<typeof textLayerSchema>;

const captionsLayerSchema = z.object({
  ...layerBase,
  type: z.literal("captions"),
  style: textStyleSchema,
  /** Words shown at once. Short cues are what make captions feel "fast". */
  maxWordsPerCue: z.number().int().min(1).max(12),
  maxCharsPerCue: z.number().int().min(4).max(80),
  /** Colour the word being spoken. null = no karaoke highlight. */
  highlightColor: hexColor.nullable(),
});
export type CaptionsLayer = z.infer<typeof captionsLayerSchema>;

/** Discriminated on `type`. To add a layer kind (image, b-roll, progress
 *  bar…): add a schema here, resolve it in plan.ts, draw it in the stage
 *  component and in the ffmpeg renderer. Array order = z-order, last on top. */
const layerSchema = z.discriminatedUnion("type", [
  textLayerSchema,
  captionsLayerSchema,
]);
export type Layer = z.infer<typeof layerSchema>;

// ─── The document ───────────────────────────────────────────────────────────

export const clipEditDocSchema = z.object({
  version: z.literal(CLIP_EDIT_DOC_VERSION),
  canvas: canvasSchema,
  sections: z.array(sectionSchema).min(1).max(20),
  video: videoPlacementSchema,
  layers: z.array(layerSchema).max(50),
  /**
   * Transcript corrections, keyed by the word's start time in ms (stable
   * across re-windowing; array indexes are not). Affects captions only —
   * correcting "Shopfy" → "Shopify" must not change the cut.
   */
  wordEdits: z.record(z.string().regex(/^\d+$/), z.string().max(80)),
});
export type ClipEditDoc = z.infer<typeof clipEditDocSchema>;

export type AspectRatio = "9:16" | "16:9" | "1:1";

const CANVAS_BY_ASPECT: Record<AspectRatio, { width: number; height: number }> =
  {
    "9:16": { width: 1080, height: 1920 },
    "16:9": { width: 1920, height: 1080 },
    "1:1": { width: 1080, height: 1080 },
  };

export function wordEditKey(startSec: number): string {
  return String(Math.round(startSec * 1000));
}

/**
 * The starting document for a clip idea. Layout mirrors the "Reels Layout"
 * the team already ships: black 9:16 canvas, the source video uncropped and
 * vertically centered, hook above it, captions below it. For a landscape
 * canvas the video fills the frame and both text layers sit over it.
 */
export function createDefaultDoc(args: {
  startSec: number;
  endSec: number;
  hook: string;
  aspectRatio?: AspectRatio;
  /** Optional prepended intro ranges (clip_ideas.hook_segments). */
  introRanges?: TimeRange[];
}): ClipEditDoc {
  const aspect = args.aspectRatio ?? "9:16";
  const vertical = aspect !== "16:9";
  const sections: Section[] = [
    ...(args.introRanges ?? []).map((r, i) => ({
      id: `intro-${i + 1}`,
      role: "intro" as const,
      startSec: r.startSec,
      endSec: r.endSec,
      removals: [],
    })),
    {
      id: "body",
      role: "body" as const,
      startSec: args.startSec,
      endSec: args.endSec,
      removals: [],
    },
  ];
  const canvas = { ...CANVAS_BY_ASPECT[aspect], fps: 30, background: "#000000" };
  const hookYPct = vertical ? 31 : 14;
  const hookWidthPct = 86;
  const hookStyle: TextStyle = {
    fontId: "montserrat-extrabold",
    sizePct: vertical ? 3.6 : 6,
    color: "#FFFFFF",
    outlinePct: vertical ? 0 : 8,
    outlineColor: "#000000",
    uppercase: false,
  };
  // AI hooks range from five words to a paragraph — start a long one at a
  // size that fits the space it has (above the video) rather than off-canvas.
  hookStyle.sizePct = fitTextSizePct({
    text: args.hook,
    style: hookStyle,
    canvas,
    widthPct: hookWidthPct,
    maxHeightPct: vertical ? hookYPct - 4 : 24,
  });

  return {
    version: CLIP_EDIT_DOC_VERSION,
    canvas,
    sections,
    video: {
      fit: vertical ? "contain" : "cover",
      yPct: 50,
      panXPct: 50,
      scalePct: 100,
      radiusPct: 0,
    },
    layers: [
      {
        id: "hook",
        type: "text",
        role: "hook",
        visible: true,
        text: args.hook,
        xPct: 50,
        // A 16:9 source centered in a 9:16 canvas spans ~34%–66%. The hook's
        // bottom edge sits just above it; captions' top edge just below.
        yPct: hookYPct,
        anchor: vertical ? "bottom" : "center",
        widthPct: hookWidthPct,
        style: hookStyle,
      },
      {
        id: "captions",
        type: "captions",
        visible: true,
        xPct: 50,
        yPct: vertical ? 69 : 84,
        anchor: vertical ? "top" : "center",
        style: {
          fontId: "montserrat-extrabold",
          sizePct: vertical ? 3.2 : 5.5,
          color: "#FFFFFF",
          outlinePct: 8,
          outlineColor: "#000000",
          uppercase: true,
        },
        maxWordsPerCue: 3,
        maxCharsPerCue: 18,
        highlightColor: "#FFE14D",
      },
    ],
    wordEdits: {},
  };
}

/**
 * Parse an untrusted / older document. Returns the validation error instead
 * of throwing so API routes can 400 with a useful message.
 */
export function parseDoc(
  raw: unknown,
): { ok: true; doc: ClipEditDoc } | { ok: false; error: string } {
  const migrated = migrateDoc(raw);
  const result = clipEditDocSchema.safeParse(migrated);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `Invalid clip edit document at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}`,
    };
  }
  return { ok: true, doc: result.data };
}

/** Upgrade older document versions to the current shape. v1 is the first
 *  version, so this is the identity for now — the seam exists so v2 has
 *  somewhere to go. */
function migrateDoc(raw: unknown): unknown {
  return raw;
}

export function findHookLayer(doc: ClipEditDoc): TextLayer | null {
  for (const layer of doc.layers) {
    if (layer.type === "text" && layer.role === "hook") return layer;
  }
  return null;
}

export function findCaptionsLayer(doc: ClipEditDoc): CaptionsLayer | null {
  for (const layer of doc.layers) {
    if (layer.type === "captions") return layer;
  }
  return null;
}
