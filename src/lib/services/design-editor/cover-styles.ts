/**
 * Cover styles — "make my cover like that one". The gallery is every
 * published Instagram slideshow cover of the brand (production_item_media
 * index 0), this format's first, best first. Picking one:
 *
 *   1. extract (once per source post, on the worker — `design-style-extract`):
 *      Opus looks at the cover image and describes it with the same
 *      `build_template` tool the PDF importer uses — boxes, fonts, colours,
 *      fades, the founder cutout, a tilted stat card — with every text an
 *      `ai` slot whose sample is the original copy. The result is a fixed
 *      one-page template on `design_cover_styles`, so the SAME style gives
 *      the SAME layout every time; only step 2 is per post.
 *   2. apply (in the request, like the hero cover): fill that template for
 *      the post being edited — the existing `generateDesignFill` +
 *      `fillTemplate`, steered to keep the post's current headline — and
 *      hand the page to the editor, which swaps page 1 (undoable) and makes
 *      the cutout in the browser when the style has one.
 */
import Anthropic from "@anthropic-ai/sdk";
import { imageSize } from "image-size";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designCoverStyles, productionItemMedia, productionItems } from "@/lib/db/schema";
import { getPresignedGetUrl } from "@/lib/s3";
import { FONT_IDS } from "@/lib/clip-editor/doc";
import { parseDesignDoc, resizeCanvas, type DesignDoc } from "@/lib/design-editor/doc";
import { IMPORT_TOOL, normalizeImportedTemplate } from "@/lib/design-editor/pdf-import";
import { HIGHLIGHT_COLORS } from "@/lib/design-editor/template-fill";
import { enqueue } from "@/jobs/enqueue";
import { buildCoverFromTemplate, type HeroCoverResult } from "./hero";
import { DesignUnsupportedError, loadItem } from "./session";

const MODEL = "claude-opus-5-5";
/** Claude's image limit; covers are ~1080px JPGs, far under it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PER_FORMAT = 48;

export const COVER_STYLE_TEMPLATE = "cover-style-v1";
export const coverStyleJobKey = (styleId: string) => `design-style-extract:${styleId}`;

export type CoverStyleStatus = "none" | "pending" | "done" | "failed";

export interface CoverStyleCard {
  /** The published post the cover belongs to. */
  productionItemId: string;
  styleId: string | null;
  status: CoverStyleStatus;
  summary: string | null;
  error: string | null;
  hook: string | null;
  format: string | null;
  views: number | null;
  publishedDate: string | null;
  /** Browser-loadable URL of the cover itself. */
  thumbnailUrl: string;
}

export interface CoverStyleGallery {
  /** This format first, then the others in order of their best post. */
  formats: string[];
  styles: CoverStyleCard[];
}

/**
 * Every published Instagram slideshow cover of the brand, grouped by
 * format: the post's own format leads, then the others by their top post.
 * Cheap — presigns only; nothing is extracted until a style is picked.
 */
export async function listCoverStyles(args: { brand: string; format: string | null }): Promise<CoverStyleGallery> {
  const rows = await db
    .select({
      id: productionItems.id,
      hook: productionItems.hook,
      title: productionItems.title,
      format: productionItems.format,
      views: productionItems.views,
      publishedDate: productionItems.publishedDate,
      bucket: productionItemMedia.s3Bucket,
      key: productionItemMedia.s3Key,
      styleId: designCoverStyles.id,
      status: designCoverStyles.status,
      summary: designCoverStyles.summary,
      error: designCoverStyles.error,
    })
    .from(productionItems)
    .innerJoin(productionItemMedia, and(eq(productionItemMedia.productionItemId, productionItems.id), eq(productionItemMedia.index, 0), like(productionItemMedia.contentType, "image/%")))
    .leftJoin(designCoverStyles, eq(designCoverStyles.productionItemId, productionItems.id))
    .where(and(eq(productionItems.brand, args.brand), eq(productionItems.status, "Published"), eq(productionItems.postType, "instagram_post")))
    .orderBy(desc(sql`coalesce(${productionItems.views}, 0)`), desc(productionItems.publishedDate));

  const byFormat = new Map<string, typeof rows>();
  for (const r of rows) {
    const f = r.format ?? "Other";
    const list = byFormat.get(f) ?? [];
    if (list.length < MAX_PER_FORMAT) list.push(r);
    byFormat.set(f, list);
  }
  // Insertion order of the map = order of each format's best post; the
  // post's own format moves to the front.
  const formats = [...byFormat.keys()];
  if (args.format && byFormat.has(args.format)) {
    formats.splice(formats.indexOf(args.format), 1);
    formats.unshift(args.format);
  }

  const styles: CoverStyleCard[] = [];
  for (const f of formats) {
    for (const r of byFormat.get(f) ?? []) {
      styles.push({
        productionItemId: r.id,
        styleId: r.styleId ?? null,
        status: (r.status as CoverStyleStatus | null) ?? "none",
        summary: r.summary ?? null,
        error: r.error ?? null,
        hook: r.hook ?? r.title ?? null,
        format: r.format,
        views: r.views,
        publishedDate: r.publishedDate ? String(r.publishedDate) : null,
        thumbnailUrl: await getPresignedGetUrl(r.key, 4 * 3600, { bucket: r.bucket }),
      });
    }
  }
  return { formats, styles };
}

export interface CoverStyleState {
  id: string;
  status: Exclude<CoverStyleStatus, "none">;
  summary: string | null;
  error: string | null;
}

/**
 * The style row for a published post, created (and its extraction queued)
 * when there is none. A failed one is re-queued so a transient model error
 * never pins a cover as unusable. Idempotent: the job key dedupes.
 */
export async function ensureCoverStyle(productionItemId: string): Promise<CoverStyleState> {
  const [media] = await db
    .select({ bucket: productionItemMedia.s3Bucket, key: productionItemMedia.s3Key, status: productionItems.status })
    .from(productionItemMedia)
    .innerJoin(productionItems, eq(productionItems.id, productionItemMedia.productionItemId))
    .where(and(eq(productionItemMedia.productionItemId, productionItemId), eq(productionItemMedia.index, 0), like(productionItemMedia.contentType, "image/%")))
    .limit(1);
  if (!media) throw new DesignUnsupportedError("ai_failed", "that post has no cover image to read");

  const [existing] = await db.select().from(designCoverStyles).where(eq(designCoverStyles.productionItemId, productionItemId)).limit(1);
  let row = existing;
  if (!row) {
    [row] = await db
      .insert(designCoverStyles)
      .values({ productionItemId, mediaS3Bucket: media.bucket, mediaS3Key: media.key })
      .onConflictDoNothing({ target: designCoverStyles.productionItemId })
      .returning();
    if (!row) [row] = await db.select().from(designCoverStyles).where(eq(designCoverStyles.productionItemId, productionItemId)).limit(1);
  } else if (row.status === "failed") {
    [row] = await db.update(designCoverStyles).set({ status: "pending", error: null, updatedAt: sql`now()` }).where(eq(designCoverStyles.id, row.id)).returning();
  }
  if (row.status === "pending") await enqueue("design-style-extract", { styleId: row.id }, { jobKey: coverStyleJobKey(row.id), maxAttempts: 2 });
  return { id: row.id, status: row.status as CoverStyleState["status"], summary: row.summary, error: row.error };
}

export async function getCoverStyle(styleId: string): Promise<CoverStyleState | null> {
  const [row] = await db.select({ id: designCoverStyles.id, status: designCoverStyles.status, summary: designCoverStyles.summary, error: designCoverStyles.error }).from(designCoverStyles).where(eq(designCoverStyles.id, styleId)).limit(1);
  return row ? { ...row, status: row.status as CoverStyleState["status"] } : null;
}

/**
 * Rebuild the post's cover in a style: the style's template page, resized
 * to the post's canvas, filled for this post. Throws DesignUnsupportedError
 * when the style isn't readable yet.
 */
export async function applyCoverStyle(args: {
  productionItemId: string;
  styleId: string;
  canvas: { width: number; height: number } | null;
  currentHeadline: string | null;
  instruction: string | null;
}): Promise<HeroCoverResult> {
  const [style] = await db.select().from(designCoverStyles).where(eq(designCoverStyles.id, args.styleId)).limit(1);
  if (!style) throw new DesignUnsupportedError("ai_failed", "that cover style no longer exists");
  if (style.status !== "done" || !style.doc) throw new DesignUnsupportedError("ai_failed", style.status === "failed" ? `that cover couldn't be read: ${style.error ?? "unknown error"}` : "that cover is still being read — try again in a few seconds");
  const parsed = parseDesignDoc(style.doc);
  if (!parsed.ok) throw new DesignUnsupportedError("ai_failed", `that cover style is corrupt (${parsed.error})`);
  const item = await loadItem(args.productionItemId);
  const template = args.canvas ? resizeCanvas(parsed.doc, args.canvas) : parsed.doc;
  return buildCoverFromTemplate({ item, template: { ...template, pages: template.pages.slice(0, 1) }, currentHeadline: args.currentHeadline, instruction: args.instruction, label: "that cover style" });
}

// ---------------------------------------------------------------------------
// Extraction (worker)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You turn ONE published Instagram cover image into a one-page DESIGN TEMPLATE for our in-app design editor, so other posts can be rebuilt in exactly this look. Later, for each post, the AI fills the "ai" text slots from that post's video transcript and the picture slots get that post's own photos — the LAYOUT you describe is kept verbatim. Be precise about positions, sizes and colours: measure against the image size you state.

Describe the cover with build_template: one page, elements back to front (z-order), boxes in the image's own pixel units (state pageWidth/pageHeight = the image size), origin top-left.

What the editor can draw — use only this:
- picture: a photo box (cover-fitted). slot "photo" = the founder/guest photo filling an area (full-bleed backdrop or a panel). slot "cutout" = the person CUT OUT of their photo (crisp edge, no background, overlapping cards/text behind them, standing on the bottom edge). A cutout cover is usually TWO pictures: a "photo" backdrop (full page, often the same shot zoomed and darkened by a rect over it) and the "cutout" on top. slot "screen" = a dashboard/revenue screenshot. slot "wordmark" = the brand's own logo (Starter Story / HubSpot Media) — give its box and theme (dark page → "dark"). slot "placeholder" = any other logo/graphic.
- statCard: a dashboard tile with a small label, a big number, a small sub line and a chart — give label/value/sub as shown, accent (chart colour), theme, rotation if tilted.
- rect: a flat or linearly-faded box (fill → gradientTo, down or up): dark fades under text over photos, colour bands, cards, a dimming layer over the whole photo (black at ~0.5–0.7).
- text: one font (from the bundled list), size, line height, letter spacing, colour, alignment, uppercase, soft drop shadow. Coloured phrases (highlights) inside the text — colour only.
- channel: the brand's avatar + name + follower row, if shown.

How to read it:
- EVERY piece of copy that changes per post (headline, sub-line, footer teaser, stat numbers) is slot "ai": text = exactly what the cover says (it becomes the style example — length matters), hint = what to write for another post (role, length in words, tone, what to highlight in which colour). The headline's hint must say to lead with the founder's real result/number. Keep fixed copy (a CTA like "See his playbook →", a handle) as "static" only if it is truly the same on every post; teasers that mention the post's content are "ai".
- Highlight colours: list them as highlights with the cover's colour; our standard ones are ${Object.entries(HIGHLIGHT_COLORS).map(([k, v]) => `${k} ${v}`).join(", ")} — use the nearest unless clearly different.
- Fonts: pick the closest from ${FONT_IDS.join(", ")}. Condensed heavy caps → anton or bebas-neue; geometric sans → inter-regular / inter-bold.
- Text over a photo needs the fade the cover has between them — and get its STRENGTH right, it is what makes the headline readable. Look at where the picture is still clearly visible and where it has become black: the fade rect covers ONLY that transition band (often just 120–300px tall, fill black alpha 0 → gradientTo black alpha 0.95–1), and the fully black area below it is a separate SOLID black rect (alpha 0.95–1) running to the bottom edge. The headline box must sit on the solid part, never on the half-transparent band. A single gentle fade over the whole lower half is almost always wrong.
- Headline box: measure it generously (the full width the lines span, the full height of all lines) and give the font size of the CAPITAL letters as drawn; valign "middle" when the lines are centred in a dark band.
- Text: no "\\n" in the copy — the lines you see are soft wraps of one paragraph; the editor re-wraps for each post. Only a deliberate blank line between paragraphs (a quote and its attribution) is a real break.
- Hand-drawn arrows, scribbles, stickers, emoji and other decorations that point at something in the photo: SKIP them (say so in the notes) — they can't be redrawn for another photo. Don't invent elements the cover doesn't have. Skip Instagram UI chrome if any is visible.

Then write "notes": ONE sentence naming the look for a gallery tooltip ("Founder cut out over a dimmed backdrop, tilted revenue card behind, Anton headline with green number"). Call build_template exactly once.`;

async function callModel(client: Anthropic, image: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }, context: string, retryError: string | null): Promise<{ input: unknown } | { error: string }> {
  const content: Anthropic.ContentBlockParam[] = [
    { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
    { type: "text", text: context },
  ];
  if (retryError) content.push({ type: "text", text: `A previous attempt produced an invalid template (${retryError}). Be careful with the page size, boxes and hex colours.` });
  content.push({ type: "text", text: "Describe this cover now with build_template." });
  try {
    const message = await client.messages
      .stream({
        model: MODEL,
        max_tokens: 24000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: SYSTEM_PROMPT,
        tools: [IMPORT_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content }],
      })
      .finalMessage();
    if (message.stop_reason === "refusal") return { error: "The model declined to read this cover" };
    if (message.stop_reason === "max_tokens") return { error: "The cover was too complex to describe in one go" };
    const call = message.content.find((b) => b.type === "tool_use" && b.name === IMPORT_TOOL.name);
    if (!call || call.type !== "tool_use") return { error: "The model didn't return a template" };
    return { input: call.input };
  } catch (err) {
    if (err instanceof Anthropic.APIError) return { error: `Claude API error ${err.status ?? ""}: ${err.message}`.trim() };
    throw err;
  }
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

async function finish(styleId: string, patch: { status: "done" | "failed"; doc?: DesignDoc; summary?: string | null; error?: string | null }) {
  await db
    .update(designCoverStyles)
    .set({ status: patch.status, doc: patch.doc ?? null, summary: patch.summary ?? null, error: patch.error ?? null, updatedAt: sql`now()` })
    .where(eq(designCoverStyles.id, styleId));
}

/**
 * Read one cover into its template (the `design-style-extract` task).
 * Idempotent: a row that is already done is left alone; a failed one is
 * retried only through `ensureCoverStyle`.
 */
export async function extractCoverStyle(styleId: string, opts: { client?: Anthropic; log?: (msg: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const [row] = await db.select().from(designCoverStyles).where(eq(designCoverStyles.id, styleId)).limit(1);
  if (!row || row.status !== "pending") return log(`design-style-extract: ${styleId} is ${row?.status ?? "missing"}; skipping`);
  const [post] = await db.select({ hook: productionItems.hook, title: productionItems.title, format: productionItems.format, brand: productionItems.brand }).from(productionItems).where(eq(productionItems.id, row.productionItemId)).limit(1);
  if (!post) return finish(styleId, { status: "failed", error: "The post no longer exists" });

  const res = await fetch(await getPresignedGetUrl(row.mediaS3Key, 900, { bucket: row.mediaS3Bucket ?? undefined }));
  if (!res.ok) return finish(styleId, { status: "failed", error: `Couldn't download the cover image (${res.status})` });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) return finish(styleId, { status: "failed", error: `The cover image is too big to read (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; limit 5 MB)` });
  const contentType = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
  const mediaType = (IMAGE_TYPES as readonly string[]).includes(contentType) ? (contentType as (typeof IMAGE_TYPES)[number]) : row.mediaS3Key.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

  const dims = imageSize(bytes);
  const context = [
    `## THE IMAGE\n${dims.width} × ${dims.height} pixels — use exactly these as pageWidth / pageHeight and give every box in these pixels.`,
    `## THE POST\nFormat: ${post.format ?? "unknown"}\nBrand: ${post.brand ?? ""}`,
    post.hook?.trim() ? `Its headline as published (the cover's main text should match this): ${post.hook.trim()}` : post.title ? `Title: ${post.title}` : "",
  ].filter(Boolean).join("\n");
  const client = opts.client ?? new Anthropic();

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const out = await callModel(client, { base64: bytes.toString("base64"), mediaType }, context, lastError);
    log(`design-style-extract: ${styleId} attempt ${attempt} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if ("error" in out) {
      lastError = out.error;
      continue;
    }
    // The page size is a fact we know — never let a misread one skew every box.
    const described = out.input && typeof out.input === "object" ? { ...(out.input as Record<string, unknown>), pageWidth: dims.width, pageHeight: dims.height } : out.input;
    const normalized = normalizeImportedTemplate(described);
    if (!normalized.ok) {
      lastError = normalized.error;
      continue;
    }
    const page = normalized.doc.pages[0];
    if (!page || page.elements.length === 0) {
      lastError = "The template came back with no elements";
      continue;
    }
    if (!page.elements.some((e) => e.slot?.kind === "ai")) {
      lastError = "No text on the cover was marked as something the AI writes per post";
      continue;
    }
    return finish(styleId, { status: "done", doc: { ...normalized.doc, template: COVER_STYLE_TEMPLATE, pages: [page] }, summary: normalized.notes.split("\n")[0].slice(0, 200) || null });
  }
  return finish(styleId, { status: "failed", error: lastError ?? "Couldn't read the cover" });
}

/** For tests and the dev script: the style rows for a set of posts. */
export async function coverStylesFor(productionItemIds: string[]) {
  if (productionItemIds.length === 0) return [];
  return db.select().from(designCoverStyles).where(inArray(designCoverStyles.productionItemId, productionItemIds));
}
