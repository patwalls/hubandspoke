/**
 * Design editor session — everything the editor needs to open on one
 * production item. On first open there is no document yet: the AI writes a
 * brief from the source transcript and the template builds the first draft.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands, designDocs, designRenders, formats, productionItems, transcripts } from "@/lib/db/schema";
import { parseDesignDoc, type DesignDoc, type DesignImageSource } from "@/lib/design-editor/doc";
import type { DesignContext } from "@/lib/design-editor/shared";
import { applyDmKeyword, applyPhotoPick, fillTemplate, hasDmKeywordSlot, type DesignFill } from "@/lib/design-editor/template-fill";
import { DM_KEYWORD_TOKEN } from "@/lib/design-editor/doc";
import type { ChannelInfo } from "@/lib/design-editor/channel";
import { loadBrandChannels } from "./channels";
import { ensureDmKeyword } from "@/lib/services/dm-keyword";
import { resolveTranscriptWords, type EditorWord } from "@/lib/clip-editor/words";
import { getPresignedGetUrl } from "@/lib/s3";
import { generateDesignFill } from "./fill-brief";
import { loadFormatTemplate } from "./format-template";
import { BRAND_WORDMARKS, previewUrlFor, sourceImageCandidates, type ImageCandidate } from "./assets";
import { listFrames, pickedFrame, requestAutoFrames, type DesignFramesState } from "./frames";
import { toDesignRenderStatus, type DesignRenderStatus } from "./render-status";

export class DesignItemNotFoundError extends Error {
  constructor() {
    super("Item not found");
    this.name = "DesignItemNotFoundError";
  }
}

export class DesignUnsupportedError extends Error {
  constructor(public readonly reason: "no_template" | "no_transcript" | "ai_failed", detail?: string) {
    super(
      reason === "no_template"
        ? "This format has no design template yet"
        : reason === "no_transcript"
          ? "The source video has no transcript yet"
          : `The AI couldn't draft this post${detail ? `: ${detail}` : ""}`,
    );
    this.name = "DesignUnsupportedError";
  }
}

export interface DesignEditorSession {
  item: {
    id: string;
    title: string | null;
    brand: string;
    format: string | null;
    /** The format row, for the link to its template on the format page. */
    formatId: string | null;
    status: string | null;
    postType: string | null;
    sourceItemId: string;
    sourceTitle: string | null;
  };
  design: { id: string; revision: number; doc: DesignDoc; brief: DesignFill | null; briefInstruction: string | null };
  /** Element id → URL the browser can load, for every image in the doc. */
  imageUrls: Record<string, string>;
  /** Pictures available to place. */
  images: ImageCandidate[];
  /** Frames grabbed from the source video (+ whether more are coming). */
  frames: DesignFramesState;
  /** The source video, for video slides and the frame scrubber. */
  source: { videoUrl: string; bucket: string | null; key: string; title: string | null } | null;
  /** The source transcript's words — captions on video slides are cut from
   *  these in the browser exactly as the exporter cuts them. */
  words: EditorWord[];
  /** The brand's accounts, for channel elements. */
  channels: ChannelInfo[];
  /** The post's attached ManyChat keyword (`short_link_slug`), if any. */
  dmKeyword: string | null;
  latestRender: DesignRenderStatus | null;
}

export async function loadDesignEditorSession(args: {
  productionItemId: string;
  userId: string;
}): Promise<DesignEditorSession> {
  const item = await loadItem(args.productionItemId);
  const template = item.format ? await loadFormatTemplate(item.brand, item.format) : null;
  if (!template) throw new DesignUnsupportedError("no_template");

  // Kick the filmstrip off first — it runs on the worker while the AI writes
  // the brief, so the first draft usually already has a real photo.
  await requestAutoFrames(item.id, item.sourceItemId).catch((err) => console.error("design-frames enqueue failed:", err));

  let design = await selectDesign(item.id);
  if (!design) {
    // A template with a DM-keyword CTA gets the post a keyword up front —
    // the best free one from the ManyChat pool, pointed at the post's
    // suggested destination — so the CTA never shows a placeholder.
    if (hasDmKeywordSlot(template.doc)) await ensureDmKeyword(item.id).catch((err) => console.error("[design-editor] ensureDmKeyword failed:", err));
    const draft = await draftDoc(item.id, item.sourceItemId, template.doc, null);
    await db
      .insert(designDocs)
      .values({ productionItemId: item.id, doc: draft.doc, brief: draft.fill as unknown as Record<string, unknown>, createdByUserId: args.userId })
      .onConflictDoNothing({ target: designDocs.productionItemId });
    design = await selectDesign(item.id);
    if (!design) throw new Error("Failed to create design");
  } else {
    // The pick landed after the draft was made (or the last editor closed
    // before it did): put it in the photo slots now, before anyone holds
    // the doc.
    const pick = await pickedFrame(item.id);
    let next = pick?.src ? applyPhotoPick(design.doc, pick.src)?.doc ?? null : null;
    // A keyword attached after the draft (content page) fills the CTA now.
    const slug = await currentDmKeyword(item.id);
    if (slug && JSON.stringify(next ?? design.doc).includes(DM_KEYWORD_TOKEN)) next = applyDmKeyword(next ?? design.doc, slug);
    if (next) {
      await db
        .update(designDocs)
        .set({ doc: next, revision: sql`${designDocs.revision} + 1`, updatedAt: new Date() })
        .where(and(eq(designDocs.id, design.id), eq(designDocs.revision, design.revision)));
      design = (await selectDesign(item.id)) ?? design;
    }
  }

  return finishSession(item, design);
}

export async function regenerateDesign(args: {
  productionItemId: string;
  instruction: string | null;
  userId: string;
}): Promise<DesignEditorSession> {
  const item = await loadItem(args.productionItemId);
  const template = item.format ? await loadFormatTemplate(item.brand, item.format) : null;
  if (!template) throw new DesignUnsupportedError("no_template");
  if (hasDmKeywordSlot(template.doc)) await ensureDmKeyword(item.id).catch((err) => console.error("[design-editor] ensureDmKeyword failed:", err));
  const draft = await draftDoc(item.id, item.sourceItemId, template.doc, args.instruction);
  await db
    .insert(designDocs)
    .values({ productionItemId: item.id, doc: draft.doc, brief: draft.fill as unknown as Record<string, unknown>, briefInstruction: args.instruction, createdByUserId: args.userId })
    .onConflictDoUpdate({
      target: designDocs.productionItemId,
      set: {
        doc: draft.doc,
        brief: draft.fill as unknown as Record<string, unknown>,
        briefInstruction: args.instruction,
        // A regeneration replaces the doc wholesale → new revision, so an
        // editor still holding the old one gets a conflict, not a clobber.
        revision: sql`${designDocs.revision} + 1`,
        updatedAt: new Date(),
      },
    });
  const design = await selectDesign(item.id);
  if (!design) throw new Error("Design vanished");
  return finishSession(item, design);
}

async function draftDoc(itemId: string, sourceItemId: string, template: DesignDoc, instruction: string | null) {
  const result = await generateDesignFill({ productionItemId: itemId, template, instruction });
  if (!result.ok) {
    if (result.failure.reason === "no-transcript") throw new DesignUnsupportedError("no_transcript");
    throw new DesignUnsupportedError("ai_failed", result.failure.message ?? result.failure.reason);
  }
  const source = await loadSource(sourceItemId);
  const words = await loadWords(sourceItemId);
  const fill: DesignFill = {
    ...result.fill,
    values: result.fill.values.map((v) => (v.startSec !== undefined && v.endSec !== undefined ? { ...v, ...snapClipToWords({ startSec: v.startSec, endSec: v.endSec, label: "" }, words) } : v)),
  };
  // The cover photo: the AI's pick from the video's frames. If the frames
  // aren't in yet the photo slot keeps its placeholder — the editor fills it
  // the moment the pick lands (applyPhotoPick). Falling back to the platform
  // thumbnail is worse than nothing: it's usually a YouTube thumbnail with
  // its own text baked in. Only image-only sources use their pictures.
  const pick = await pickedFrame(itemId);
  const images = source ? [] : await sourceImageCandidates(sourceItemId);
  const photo: DesignImageSource | null = pick?.src ?? images[0]?.src ?? null;
  const ctx: DesignContext = {
    photo,
    source: source ? { bucket: source.bucket, key: source.key, title: source.title } : null,
    channel: await loadChannel(itemId),
    dmKeyword: await currentDmKeyword(itemId),
  };
  return { fill, doc: fillTemplate(template, fill, ctx) };
}

/** Move a clip's edges to word boundaries so it never starts mid-word, and
 *  keep it inside the transcript. Pure; exported for tests. */
export function snapClipToWords(clip: { startSec: number; endSec: number; label: string }, words: EditorWord[]) {
  if (words.length === 0) return clip;
  let start = clip.startSec;
  let end = clip.endSec;
  // First word starting at/after the requested start (or the last one before it).
  const firstAfter = words.find((w) => w.startSec >= start - 0.3);
  if (firstAfter && Math.abs(firstAfter.startSec - start) <= 3) start = Math.max(0, firstAfter.startSec - 0.15);
  // Last word ending at/before the requested end.
  let lastBefore: EditorWord | undefined;
  for (const w of words) {
    if (w.endSec <= end + 0.3) lastBefore = w;
    else break;
  }
  if (lastBefore && Math.abs(lastBefore.endSec - end) <= 3) end = lastBefore.endSec + 0.25;
  const lastWordEnd = words[words.length - 1].endSec;
  end = Math.min(end, lastWordEnd + 0.5);
  if (end - start < 3) return clip;
  return { ...clip, startSec: Math.round(start * 100) / 100, endSec: Math.round(end * 100) / 100 };
}

async function loadSource(sourceItemId: string) {
  const [row] = await db
    .select({ key: productionItems.mediaS3Key, bucket: productionItems.mediaS3Bucket, title: productionItems.title })
    .from(productionItems)
    .where(eq(productionItems.id, sourceItemId))
    .limit(1);
  if (!row?.key || !/\.(mp4|mov|m4v|webm)$/i.test(row.key)) return null;
  return { key: row.key, bucket: row.bucket, title: row.title };
}

async function loadWords(sourceItemId: string): Promise<EditorWord[]> {
  const [t] = await db
    .select({ words: transcripts.words, segments: transcripts.segments })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, sourceItemId))
    .limit(1);
  if (!t) return [];
  return resolveTranscriptWords({ words: t.words, segments: t.segments ?? [] }).words;
}

async function currentDmKeyword(itemId: string): Promise<string | null> {
  const [row] = await db.select({ slug: productionItems.shortLinkSlug }).from(productionItems).where(eq(productionItems.id, itemId)).limit(1);
  return row?.slug ?? null;
}

/** The channel row on video slides: the brand's YouTube account. */
async function loadChannel(itemId: string): Promise<DesignContext["channel"]> {
  const fallback = { name: "Starter Story", subscribers: "" };
  const [item] = await db.select({ brand: productionItems.brand }).from(productionItems).where(eq(productionItems.id, itemId)).limit(1);
  if (!item?.brand) return fallback;
  const [acct] = await db
    .select({ displayName: accounts.displayName, handle: accounts.handle, followerCount: accounts.followerCount, label: brands.label })
    .from(accounts)
    .innerJoin(brands, eq(brands.id, accounts.brandId))
    .where(and(eq(brands.slug, item.brand), eq(accounts.platform, "youtube")))
    .orderBy(desc(accounts.followerCount))
    .limit(1);
  if (!acct) return fallback;
  const n = acct.followerCount ?? 0;
  const subs = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 < 50_000 ? 0 : 1)}M subscribers` : n >= 1000 ? `${Math.round(n / 1000)}K subscribers` : n > 0 ? `${n} subscribers` : "";
  return { name: acct.displayName ?? acct.label ?? acct.handle ?? fallback.name, subscribers: subs };
}

async function loadItem(id: string) {
  const [row] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      format: productionItems.format,
      status: productionItems.status,
      postType: productionItems.postType,
      pillarContentItemId: productionItems.pillarContentItemId,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!row) throw new DesignItemNotFoundError();
  const sourceItemId = row.pillarContentItemId ?? row.id;
  const [source] = await db.select({ title: productionItems.title }).from(productionItems).where(eq(productionItems.id, sourceItemId)).limit(1);
  const [format] = row.format
    ? await db.select({ id: formats.id }).from(formats).where(and(eq(formats.brand, row.brand ?? "starter-story"), eq(formats.name, row.format))).limit(1)
    : [];
  return {
    id: row.id,
    title: row.title,
    brand: row.brand ?? "starter-story",
    format: row.format,
    formatId: format?.id ?? null,
    status: row.status,
    postType: row.postType,
    sourceItemId,
    sourceTitle: source?.title ?? null,
  };
}

async function selectDesign(productionItemId: string) {
  const [row] = await db
    .select({ id: designDocs.id, revision: designDocs.revision, doc: designDocs.doc, brief: designDocs.brief, briefInstruction: designDocs.briefInstruction })
    .from(designDocs)
    .where(eq(designDocs.productionItemId, productionItemId))
    .limit(1);
  if (!row) return null;
  const parsed = parseDesignDoc(row.doc);
  if (!parsed.ok) throw new Error(`Stored design ${row.id} is invalid: ${parsed.error}`);
  return { id: row.id, revision: row.revision, doc: parsed.doc, brief: (row.brief as unknown as DesignFill | null) ?? null, briefInstruction: row.briefInstruction };
}

async function finishSession(item: Awaited<ReturnType<typeof loadItem>>, design: NonNullable<Awaited<ReturnType<typeof selectDesign>>>): Promise<DesignEditorSession> {
  const imageUrls = await resolveImageUrls(design.doc);
  const [render] = await db.select().from(designRenders).where(eq(designRenders.designDocId, design.id)).orderBy(desc(designRenders.createdAt)).limit(1);
  const source = await loadSource(item.sourceItemId);
  return {
    item,
    design,
    imageUrls,
    images: [...(await sourceImageCandidates(item.sourceItemId)), ...BRAND_WORDMARKS],
    frames: await listFrames(item.id),
    source: source ? { ...source, videoUrl: await getPresignedGetUrl(source.key, 4 * 3600, { bucket: source.bucket ?? undefined }) } : null,
    words: await loadWords(item.sourceItemId),
    channels: await loadBrandChannels(item.brand),
    dmKeyword: await currentDmKeyword(item.id),
    latestRender: render ? toDesignRenderStatus(render) : null,
  };
}

export async function resolveImageUrls(doc: DesignDoc): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const page of doc.pages) {
    for (const el of page.elements) {
      if (el.type === "image") out[el.id] = await previewUrlFor(el.src);
    }
  }
  return out;
}
