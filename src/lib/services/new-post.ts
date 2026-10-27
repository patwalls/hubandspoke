/**
 * The nav's New menu, for posts: pick a platform, a format, the PILLAR the
 * post is made from and (optionally) an angle → the post exists and opens
 * in the editor that makes it (editorForNewPost):
 *
 *   design — an Instagram post on a format with a design template: the same
 *            item the Repurposed queue's designer makes (create-item.ts).
 *   clip   — a reel or Short: Haiku picks the moment (pick-post-clip.ts,
 *            "short"; the angle wins over the Skill), a clip idea + its post
 *            are written, and the clip editor opens with the format's look.
 *            A video post on X goes through the queue's own path
 *            (clip-editor/from-candidate.ts).
 *   post   — everything else (LinkedIn, X text, YouTube community, an IG
 *            post with no template): the item, and the Draft Algorithm
 *            writes its copy; the post's page opens.
 *
 * The angle lives on `production_items.angle` and steers every one of those
 * drafts. A format is optional — prod has no YouTube community format yet —
 * and a post without one is drafted from the platform's defaults.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipIdeas, formatChannels, formats, productionItems, repurposeTriggers, transcripts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import { editorForNewPost, isShortPostType, newPostKind } from "@/lib/new-post-kinds";
import { pickBestAccountForFormat } from "@/lib/format-channels";
import { recordItemCreated } from "@/lib/services/item-created";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { loadFormatTemplate } from "@/lib/services/design-editor/format-template";
import { youtubeIdFrom } from "@/lib/services/design-editor/assets";
import { findOrCreateDesignItem } from "@/lib/services/design-editor/create-item";
import { ClipPostCreateError, findOrCreateClipPost, formatsForClipPosts } from "@/lib/services/clip-editor/from-candidate";
import { pickPostClip, POST_CLIP_PICKER_VERSION } from "@/lib/services/clip-editor/pick-post-clip";
import type { PostType } from "@/lib/platform-field-schemas";

export const NEW_POST_CREATED_VIA = "new-menu";
const ANGLE_MAX_CHARS = 2_000;
/** How far back the pillar picker looks. */
const PILLAR_DAYS = 120;

export class NewPostError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 422) {
    super(message);
    this.name = "NewPostError";
  }
}

type Editor = "design" | "clip" | "post";
type Flags = { designEditor: boolean; clipEditor: boolean };

export interface NewPostFormatOption {
  id: string;
  name: string;
  editor: Editor;
}

export interface NewPostPillarOption {
  id: string;
  title: string | null;
  publishedAt: string | null;
  hasTranscript: boolean;
  /** An archived video the clip editor can cut (not audio-only). */
  hasVideo: boolean;
  /** For the dialog's watch-it preview; null when the item has no YouTube link. */
  youtubeId: string | null;
}

/** The brand's formats that post to this kind's platform, each with the editor it opens in. */
export async function listNewPostFormats(brand: string, kindKey: string, flags: Flags): Promise<NewPostFormatOption[]> {
  const kind = newPostKind(kindKey);
  if (!kind) throw new NewPostError("Unknown kind", 400);
  const rows = await db
    .selectDistinct({ id: formats.id, name: formats.name })
    .from(formats)
    .innerJoin(formatChannels, eq(formatChannels.formatId, formats.id))
    .where(and(eq(formats.brand, brand), eq(formatChannels.postType, kind.postType)))
    .orderBy(formats.name);
  const xVideo = kind.postType === "x" && flags.clipEditor ? new Set(await formatsForClipPosts(brand)) : new Set<string>();
  const out: NewPostFormatOption[] = [];
  for (const r of rows) {
    const hasDesignTemplate = kind.postType === "instagram_post" && !!(await loadFormatTemplate(brand, r.name));
    out.push({ id: r.id, name: r.name, editor: editorForNewPost({ postType: kind.postType, hasDesignTemplate, isXVideoFormat: xVideo.has(r.name), flags }) });
  }
  return out;
}

/** The brand's recent long-form videos — what a post is made from. */
export async function listNewPostPillars(brand: string): Promise<NewPostPillarOption[]> {
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedAt: sql<string | null>`${published}`,
      transcriptId: transcripts.id,
      mediaS3Key: productionItems.mediaS3Key,
      mediaContentType: productionItems.mediaContentType,
      youtubeId: productionItems.youtubeId,
      youtubeUrl: productionItems.youtubeUrl,
      publishedLink: productionItems.publishedLink,
    })
    .from(productionItems)
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} > now() - make_interval(days => ${PILLAR_DAYS})`,
      ),
    )
    .orderBy(desc(published))
    .limit(60);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    hasTranscript: r.transcriptId != null,
    hasVideo: !!r.mediaS3Key && !r.mediaContentType?.startsWith("audio/"),
    youtubeId: r.youtubeId ?? youtubeIdFrom(r.youtubeUrl) ?? youtubeIdFrom(r.publishedLink),
  }));
}

export interface CreateNewPostResult {
  editor: Editor;
  productionItemId: string;
  /** Set when editor = clip. */
  clipIdeaId?: string;
}

export async function createNewPost(args: {
  kind: string;
  brand: string;
  formatId: string | null;
  pillarId: string;
  angle: string | null;
  actorUserId: string;
  flags: Flags;
  /** Override for tests. */
  pick?: typeof pickPostClip;
}): Promise<CreateNewPostResult> {
  const kind = newPostKind(args.kind);
  if (!kind) throw new NewPostError("Unknown kind", 400);
  const angle = args.angle?.trim().slice(0, ANGLE_MAX_CHARS) || null;
  const [pillar] = await db.select().from(productionItems).where(eq(productionItems.id, args.pillarId)).limit(1);
  if (!pillar || pillar.deletedAt) throw new NewPostError("Pillar content not found", 404);
  if (pillar.brand !== args.brand) throw new NewPostError("The pillar belongs to another brand", 400);

  let format: { id: string; name: string } | null = null;
  if (args.formatId) {
    const [row] = await db
      .select({ id: formats.id, name: formats.name, brand: formats.brand })
      .from(formats)
      .where(eq(formats.id, args.formatId))
      .limit(1);
    if (!row || row.brand !== args.brand) throw new NewPostError("Format not found", 404);
    format = { id: row.id, name: row.name };
  }

  const hasDesignTemplate = !!format && kind.postType === "instagram_post" && !!(await loadFormatTemplate(args.brand, format.name));
  const isXVideoFormat = !!format && kind.postType === "x" && args.flags.clipEditor && (await formatsForClipPosts(args.brand)).includes(format.name);
  const editor = editorForNewPost({ postType: kind.postType, hasDesignTemplate, isXVideoFormat, flags: args.flags });

  if (editor === "design" && format) {
    const made = await findOrCreateDesignItem({ pillarId: pillar.id, targetFormatId: format.id, actorUserId: args.actorUserId, angle });
    // Reopening an open design of this pair: the new angle still steers its Regenerate / Draft Algorithm.
    if (!made.created && angle) await db.update(productionItems).set({ angle }).where(eq(productionItems.id, made.productionItemId));
    return { editor, productionItemId: made.productionItemId };
  }

  if (editor === "clip" && format && kind.postType === "x") {
    try {
      const made = await findOrCreateClipPost({ pillarId: pillar.id, targetFormatId: format.id, actorUserId: args.actorUserId, angle, pick: args.pick });
      return { editor, productionItemId: made.productionItemId, clipIdeaId: made.clipIdeaId };
    } catch (err) {
      // A format that posts the whole video, or a pillar with no video yet:
      // the post is still worth making, as copy.
      if (!(err instanceof ClipPostCreateError)) throw err;
    }
  } else if (editor === "clip" && isShortPostType(kind.postType)) {
    return createShort({ pillar, format, postType: kind.postType, angle, actorUserId: args.actorUserId, pick: args.pick ?? pickPostClip });
  }

  const productionItemId = await insertNewItem({ pillar, format, postType: kind.postType, angle, actorUserId: args.actorUserId });
  await recordCreated(productionItemId, { actorUserId: args.actorUserId, postType: kind.postType });
  // The Draft Algorithm writes the post's copy (caption etc.), steered by the angle.
  try {
    await enqueue("draft-algorithm-run", { productionItemId }, { jobKey: `draft-algorithm-run:${productionItemId}` });
  } catch (err) {
    console.error("draft-algorithm-run enqueue (new-menu) failed:", err);
  }
  return { editor: "post", productionItemId };
}

type Pillar = typeof productionItems.$inferSelect;

/** A reel or Short: pick the moment, then the clip idea + its post. The
 *  edit itself is made when the editor opens (session.ts: the format's
 *  aspect and saved look). */
async function createShort(args: {
  pillar: Pillar;
  format: { id: string; name: string } | null;
  postType: string;
  angle: string | null;
  actorUserId: string;
  pick: typeof pickPostClip;
}): Promise<CreateNewPostResult> {
  const { pillar } = args;
  if (!pillar.mediaS3Key || pillar.mediaContentType?.startsWith("audio/")) {
    throw new NewPostError("This video isn't archived yet, so there's nothing to cut. Pick another, or try again once it's archived.", 422);
  }
  const [transcript] = await db
    .select({ segments: transcripts.segments, durationSec: transcripts.durationSec })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, pillar.id))
    .limit(1);
  if (!transcript || transcript.segments.length === 0) {
    throw new NewPostError("This video has no transcript yet, so the clip can't be picked. Pick another.", 422);
  }
  const [skill] = args.format
    ? await db.select({ instructions: formats.instructions }).from(formats).where(eq(formats.id, args.format.id)).limit(1)
    : [];
  const result = await args.pick({
    formatName: args.format?.name ?? (args.postType === "youtube_shorts" ? "YouTube Short" : "Instagram Reel"),
    skill: skill?.instructions ?? null,
    sourceTitle: pillar.title,
    segments: transcript.segments,
    durationSec: transcript.durationSec != null ? Number(transcript.durationSec) : null,
    destination: "short",
    angle: args.angle,
  });
  if (!result || result.kind !== "clip") throw new NewPostError("Couldn't pick a clip from this video. Pick another.", 422);
  const { pick } = result;

  const formatName = args.format ? await canonicalFormat(pillar.brand, args.format.name) : null;
  const made = await db.transaction(async (tx) => {
    const [idea] = await tx
      .insert(clipIdeas)
      .values({
        sourceProductionItemId: pillar.id,
        targetFormat: formatName,
        batchId: randomUUID(),
        startSec: pick.startSec.toFixed(3),
        endSec: pick.endSec.toFixed(3),
        hook: pick.hook,
        angle: args.angle ?? pick.angle,
        rationale: pick.rationale,
        generatedBy: `clip-editor:${NEW_POST_CREATED_VIA}`,
        modelUsage: { picker: pick.source === "llm" ? POST_CLIP_PICKER_VERSION : "fallback" },
        status: "suggested",
      })
      .returning({ id: clipIdeas.id });
    const productionItemId = await insertNewItem({
      pillar,
      format: args.format,
      postType: args.postType,
      angle: args.angle,
      actorUserId: args.actorUserId,
      extra: { sourceClipIdeaId: idea.id, hook: pick.hook, hookSource: "clip_idea", hookExtractedAt: new Date() },
      q: tx,
    });
    await tx.update(clipIdeas).set({ acceptedProductionItemId: productionItemId }).where(eq(clipIdeas.id, idea.id));
    return { clipIdeaId: idea.id, productionItemId };
  });
  await recordCreated(made.productionItemId, { actorUserId: args.actorUserId, postType: args.postType });
  return { editor: "clip", ...made };
}

async function canonicalFormat(brand: string, name: string): Promise<string> {
  const check = await normalizeFormatForWrite(brand, name);
  return (check.ok && check.value) || name;
}

/** The post itself: the derivative item the Repurposed queue's "Assign
 *  editor" would make, assigned to whoever made it, carrying the angle. */
async function insertNewItem(args: {
  pillar: Pillar;
  format: { id: string; name: string } | null;
  postType: string;
  angle: string | null;
  actorUserId: string;
  extra?: Partial<typeof productionItems.$inferInsert>;
  q?: Pick<typeof db, "insert">;
}): Promise<string> {
  const q = args.q ?? db;
  const { pillar } = args;
  const formatName = args.format ? await canonicalFormat(pillar.brand, args.format.name) : null;
  const accountId = await accountFor(pillar.brand, formatName, args.postType);
  const [item] = await q
    .insert(productionItems)
    .values({
      brand: pillar.brand,
      title: pillar.title,
      thumbnail: pillar.thumbnail,
      status: "Assigned",
      accountId,
      postType: args.postType,
      format: formatName,
      sourceType: "repurposed",
      pillarContentNotionId: pillar.notionId,
      pillarContentItemId: pillar.id,
      utmCampaign: await generateUtmCampaign(pillar.title),
      editorUserId: args.actorUserId,
      createdVia: NEW_POST_CREATED_VIA,
      angle: args.angle,
      ...args.extra,
    })
    .returning({ id: productionItems.id });
  // Same dedup marker the manual repurpose leaves, so threshold-monitor-sweep
  // doesn't auto-create a second derivative for this pair.
  if (args.format) await q.insert(repurposeTriggers).values({ productionItemId: pillar.id, targetFormatId: args.format.id, compositionName: args.format.name });
  return item.id;
}

/** The Activity tab's first row. After the item's transaction commits. */
async function recordCreated(productionItemId: string, args: { actorUserId: string; postType: string }): Promise<void> {
  try {
    const [row] = await db.select({ format: productionItems.format }).from(productionItems).where(eq(productionItems.id, productionItemId)).limit(1);
    await recordItemCreated(db, {
      itemId: productionItemId,
      source: NEW_POST_CREATED_VIA,
      actorUserId: args.actorUserId,
      format: row?.format ?? null,
      sourceType: "repurposed",
      postType: args.postType,
    });
  } catch (err) {
    console.error("[new-menu] recordItemCreated failed", err);
  }
}

/** The account the post goes out on: the format's best performer, else the
 *  format's channel, else the brand's most-used account for the post type. */
async function accountFor(brand: string, formatName: string | null, postType: string): Promise<string | null> {
  if (formatName) {
    const best = await pickBestAccountForFormat({ brand, format: formatName, postType: postType as PostType });
    if (best) return best.accountId;
    const [channel] = await db
      .select({ accountId: formatChannels.accountId })
      .from(formatChannels)
      .innerJoin(formats, eq(formats.id, formatChannels.formatId))
      .where(and(eq(formats.brand, brand), eq(formats.name, formatName), eq(formatChannels.postType, postType)))
      .limit(1);
    if (channel) return channel.accountId;
  }
  const [used] = await db
    .select({ accountId: productionItems.accountId })
    .from(productionItems)
    .where(and(eq(productionItems.brand, brand), eq(productionItems.postType, postType), sql`${productionItems.accountId} IS NOT NULL`, isNull(productionItems.deletedAt)))
    .groupBy(productionItems.accountId)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  return used?.accountId ?? null;
}
