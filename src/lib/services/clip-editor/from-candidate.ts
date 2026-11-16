/**
 * The clip editor's entry from the Repurposed (SPOKE) queue, for video posts
 * on X (Share The BIG IDEA w/ video intro, …). A SPOKE row is a pillar ×
 * format CANDIDATE, but the editor works on a clip idea with a queue-side
 * item, so opening one makes both — the clip-idea twin of
 * design-editor/create-item.ts:
 *
 *   1. Haiku picks the stretch of the pillar the format's Skill asks for
 *      (pick-post-clip.ts — the intro, for BIG IDEA).
 *   2. A `clip_ideas` row for it (`generatedBy: clip-editor:spoke`) and the
 *      derivative item the classic "Assign editor" would create, linked by
 *      `sourceClipIdeaId` — the link the Post tab and the Draft Algorithm
 *      follow (post-draft.ts).
 *   3. The edit doc, written here rather than lazily by the session: these
 *      posts carry the pillar's own footage as-is (16:9, its captions are
 *      already burned in), so the default hook and captions start hidden —
 *      unless the format has a saved look, which wins.
 *
 * Re-opening the candidate reuses the item (and its edit), so it lands on
 * the same draft. Opening the editor is what starts the post draft
 * (session.ts → ensureClipPostDraft).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clipEdits, clipIdeas, formats, productionItems, repurposeTriggers, transcripts, type ClipPostSkillCheck } from "@/lib/db/schema";
import { applyLook, clipLookSchema, createDefaultDoc, type ClipEditDoc } from "@/lib/clip-editor/doc";
import { getChannelsForFormats, pickBestAccountForFormat } from "@/lib/format-channels";
import { recordItemCreated } from "@/lib/services/item-created";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { pickPostClip, POST_CLIP_PICKER_VERSION, type PickPostClipResult, type PostClipPick } from "./pick-post-clip";
import { classifySkill, skillChecksFor } from "./skill-clip-check";
import { routeFormat, type ClipPostRoute } from "@/lib/clip-editor/clip-post-route";
import { formatsWithDesignTemplate } from "@/lib/services/design-editor/format-template";

export const CLIP_POST_CREATED_VIA = "clip-editor";
export const CLIP_POST_GENERATED_BY = "clip-editor:spoke";

/** Post types whose SPOKE candidates open in the clip editor, post first. */
const CLIP_POST_TYPES = ["x"] as const;


export class ClipPostCreateError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 422,
    /** Machine reason, so the queue can fall back to the classic dialog
     *  quietly for the expected cases. */
    public readonly reason: "not_found" | "not_video_format" | "no_media" | "no_transcript" | "whole_video" | "not_eligible",
  ) {
    super(message);
    this.name = "ClipPostCreateError";
  }
}

/** Why a format's posts on X open in the clip editor — or don't. */
export interface ClipPostRouting extends ClipPostRoute {
  formatId: string;
  formatName: string;
}

/**
 * Every format in `brand` with an X channel, and whether its posts open in
 * the clip editor. Two signals, either one enough:
 *   - the Skill says to post a clip CUT from the video (Haiku, saved per
 *     Skill — skill-clip-check.ts), so a brand-new format works from its
 *     first post;
 *   - its published X posts usually carry a video (≥ VIDEO_SHARE of the last
 *     year's, min MIN_PUBLISHED), which catches a Skill that never says so.
 * A Skill that posts the WHOLE video stays classic either way.
 */
export async function clipPostRoutingFor(
  brand: string,
  opts: { classify?: typeof classifySkill } = {},
): Promise<ClipPostRouting[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    instructions: string | null;
    clip_post_skill_check: ClipPostSkillCheck | null;
    published: number;
    with_video: number;
  }>(sql`
    SELECT f.id, f.name, f.instructions, f.clip_post_skill_check,
      (SELECT count(*)::int FROM production_items p
        WHERE p.brand = f.brand AND lower(p.format) = lower(f.name)
          AND p.status = 'Published' AND p.deleted_at IS NULL
          AND p.created_at > now() - interval '365 days') AS published,
      (SELECT count(*)::int FROM production_items p
        WHERE p.brand = f.brand AND lower(p.format) = lower(f.name)
          AND p.status = 'Published' AND p.deleted_at IS NULL
          AND p.created_at > now() - interval '365 days'
          AND EXISTS (SELECT 1 FROM production_item_media m
                      WHERE m.production_item_id = p.id AND m.content_type LIKE 'video/%')) AS with_video
    FROM formats f
    WHERE f.brand = ${brand}
      AND EXISTS (
        SELECT 1 FROM format_channels fc
        WHERE fc.format_id = f.id AND fc.post_type IN ${sql.raw(`(${CLIP_POST_TYPES.map((t) => `'${t}'`).join(",")})`)}
      )
    ORDER BY f.name
  `);
  const designed = new Set(await formatsWithDesignTemplate(brand));
  // A design-template format never needs its Skill read — the template wins.
  const checks = await skillChecksFor(
    rows
      .filter((r) => !designed.has(r.name))
      .map((r) => ({ id: r.id, name: r.name, instructions: r.instructions, clipPostSkillCheck: r.clip_post_skill_check })),
    opts,
  );
  return rows.map((r) => {
    const check = checks.get(r.id) ?? null;
    return { formatId: r.id, formatName: r.name, ...routeFormat({ check, published: Number(r.published), withVideo: Number(r.with_video), hasDesignTemplate: designed.has(r.name) }) };
  });
}

/** The format names in `brand` whose posts open in the clip editor. */
export async function formatsForClipPosts(brand: string): Promise<string[]> {
  return (await clipPostRoutingFor(brand)).filter((r) => r.editor === "clip").map((r) => r.formatName);
}

/** Whole-video verdicts per format Skill, so a full-video format pays for
 *  the model call once per web process, not on every open. */
const wholeVideoSkills = new Map<string, true>();

type ItemRow = typeof productionItems.$inferSelect;
type FormatRow = typeof formats.$inferSelect;

/** The checks both entries share (the format opens in the clip editor; the
 *  pillar has video and a transcript), then Haiku's pick of the stretch the
 *  Skill asks for — the intro, for BIG IDEA. Throws ClipPostCreateError for
 *  every case the editor can't take. */
async function pickClipForPair(args: {
  source: ItemRow;
  target: FormatRow;
  angle?: string | null;
  pick?: typeof pickPostClip;
}): Promise<PostClipPick> {
  const { source, target } = args;
  if (!(await formatsForClipPosts(target.brand)).includes(target.name)) {
    throw new ClipPostCreateError(`${target.name} doesn't open in the clip editor`, 422, "not_video_format");
  }
  if (!source.mediaS3Key || source.mediaContentType?.startsWith("audio/")) {
    throw new ClipPostCreateError("The pillar has no archived video yet", 422, "no_media");
  }
  const [transcript] = await db
    .select({ segments: transcripts.segments, durationSec: transcripts.durationSec })
    .from(transcripts)
    .where(eq(transcripts.productionItemId, source.id))
    .limit(1);
  if (!transcript || transcript.segments.length === 0) {
    throw new ClipPostCreateError("The pillar has no transcript yet", 422, "no_transcript");
  }

  const skillKey = `${target.id}:${target.instructions ?? ""}`;
  if (wholeVideoSkills.has(skillKey)) throw wholeVideoError(target.name);
  const result: PickPostClipResult | null = await (args.pick ?? pickPostClip)({
    formatName: target.name,
    skill: target.instructions,
    sourceTitle: source.title,
    segments: transcript.segments,
    durationSec: transcript.durationSec != null ? Number(transcript.durationSec) : null,
    angle: args.angle,
  });
  if (!result) throw new ClipPostCreateError("The pillar has no transcript yet", 422, "no_transcript");
  if (result.kind === "whole_video") {
    wholeVideoSkills.set(skillKey, true);
    throw wholeVideoError(target.name);
  }
  return result.pick;
}

/**
 * The clip editor's entry from the All / Triggered tabs: the item already
 * exists (an `Idea` a view threshold or a person made for pillar × format),
 * so instead of creating one, give it what a SPOKE open would have — the
 * picked stretch as a clip idea, linked by `sourceClipIdeaId`, and the
 * starting edit. The item stays `Idea` until export moves it to Assigned
 * (export.ts), so closing the editor leaves it in the queue as a draft.
 * Its caption is kept: a post that's already written is never re-drafted
 * on open (post-draft.ts) — the Post tab's Redraft rewrites it to the cut.
 * Re-opening reuses the link.
 */
export async function attachClipPostToItem(args: {
  productionItemId: string;
  actorUserId: string;
  /** Override for tests. */
  pick?: typeof pickPostClip;
}): Promise<{ clipIdeaId: string; productionItemId: string; created: boolean }> {
  const [item] = await db.select().from(productionItems).where(eq(productionItems.id, args.productionItemId)).limit(1);
  if (!item || item.deletedAt) throw new ClipPostCreateError("Item not found", 404, "not_found");
  if (item.sourceClipIdeaId) return { clipIdeaId: item.sourceClipIdeaId, productionItemId: item.id, created: false };
  if (item.sourceType !== "repurposed" || !item.pillarContentItemId || !item.format) {
    throw new ClipPostCreateError("Only a repurposed item with a source video opens in the clip editor", 422, "not_eligible");
  }
  if (item.status !== "Idea") throw new ClipPostCreateError(`The item is already ${item.status}`, 422, "not_eligible");
  const [source] = await db.select().from(productionItems).where(eq(productionItems.id, item.pillarContentItemId)).limit(1);
  if (!source) throw new ClipPostCreateError("Source video not found", 404, "not_found");
  const [target] = await db
    .select()
    .from(formats)
    .where(and(eq(formats.brand, item.brand), sql`lower(${formats.name}) = lower(${item.format})`))
    .limit(1);
  if (!target) throw new ClipPostCreateError("Format not found", 404, "not_found");

  const pick = await pickClipForPair({ source, target, pick: args.pick });

  return db.transaction(async (tx) => {
    // Two opens at once land on ONE clip idea (the loser's pick is dropped).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`clip-post-item:${item.id}`}))`);
    const [fresh] = await tx
      .select({ sourceClipIdeaId: productionItems.sourceClipIdeaId })
      .from(productionItems)
      .where(eq(productionItems.id, item.id))
      .limit(1);
    if (fresh?.sourceClipIdeaId) return { clipIdeaId: fresh.sourceClipIdeaId, productionItemId: item.id, created: false };

    const [idea] = await tx
      .insert(clipIdeas)
      .values({
        sourceProductionItemId: source.id,
        targetFormat: item.format!,
        batchId: randomUUID(),
        startSec: pick.startSec.toFixed(3),
        endSec: pick.endSec.toFixed(3),
        hook: pick.hook,
        angle: pick.angle,
        rationale: pick.rationale,
        generatedBy: CLIP_POST_GENERATED_BY,
        modelUsage: { picker: pick.source === "llm" ? POST_CLIP_PICKER_VERSION : "fallback" },
        status: "suggested",
        acceptedProductionItemId: item.id,
      })
      .returning({ id: clipIdeas.id });
    await tx
      .update(productionItems)
      .set({
        sourceClipIdeaId: idea.id,
        ...(item.hook ? {} : { hook: pick.hook, hookSource: "clip_idea", hookExtractedAt: new Date() }),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));
    await tx.insert(clipEdits).values({
      clipIdeaId: idea.id,
      doc: clipPostDoc({ startSec: pick.startSec, endSec: pick.endSec, hook: pick.hook, look: target.clipTemplate }),
      createdByUserId: args.actorUserId,
    });
    return { clipIdeaId: idea.id, productionItemId: item.id, created: true };
  });
}

export async function findOrCreateClipPost(args: {
  pillarId: string;
  targetFormatId: string;
  actorUserId: string;
  /** The New menu's Angle: steers the pick and is kept on the item. */
  angle?: string | null;
  /** Override for tests. */
  pick?: typeof pickPostClip;
}): Promise<{ clipIdeaId: string; productionItemId: string; created: boolean }> {
  const [source] = await db.select().from(productionItems).where(eq(productionItems.id, args.pillarId)).limit(1);
  if (!source) throw new ClipPostCreateError("Source item not found", 404, "not_found");
  const [target] = await db.select().from(formats).where(eq(formats.id, args.targetFormatId)).limit(1);
  if (!target) throw new ClipPostCreateError("Target format not found", 404, "not_found");
  if (target.brand !== source.brand) throw new ClipPostCreateError("Target format must belong to the same brand", 400, "not_found");

  const existing = await findOpenClipPost(db, source.id, target.name);
  if (existing) return { ...existing, created: false };

  const pick = await pickClipForPair({ source, target, angle: args.angle, pick: args.pick });

  const channelMap = await getChannelsForFormats([target.id]);
  const channel = channelMap.get(target.id)?.find((c) => (CLIP_POST_TYPES as readonly string[]).includes(c.postType ?? "")) ?? null;
  const postType = channel?.postType ?? "x";
  const bestAccount = await pickBestAccountForFormat({ brand: source.brand, format: target.name, postType });
  const formatCheck = await normalizeFormatForWrite(source.brand, target.name);
  const canonicalFormat = (formatCheck.ok && formatCheck.value) || target.name;

  const made = await db.transaction(async (tx) => {
    // Two opens at once (a double click, two tabs, React's dev double
    // effect) must land on ONE post: serialize per pair, then look again —
    // the loser returns the winner's (its pick is simply dropped).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`clip-post:${source.id}:${target.id}`}))`);
    const raced = await findOpenClipPost(tx, source.id, canonicalFormat);
    if (raced) return { ...raced, created: false };

    const [idea] = await tx
      .insert(clipIdeas)
      .values({
        sourceProductionItemId: source.id,
        targetFormat: canonicalFormat,
        batchId: randomUUID(),
        startSec: pick.startSec.toFixed(3),
        endSec: pick.endSec.toFixed(3),
        hook: pick.hook,
        angle: pick.angle,
        rationale: pick.rationale,
        generatedBy: CLIP_POST_GENERATED_BY,
        modelUsage: { picker: pick.source === "llm" ? POST_CLIP_PICKER_VERSION : "fallback" },
        status: "suggested",
      })
      .returning({ id: clipIdeas.id });

    const [item] = await tx
      .insert(productionItems)
      .values({
        brand: source.brand,
        title: source.title,
        thumbnail: source.thumbnail,
        status: "Assigned",
        accountId: bestAccount?.accountId ?? channel?.accountId ?? null,
        postType,
        format: canonicalFormat,
        sourceType: "repurposed",
        pillarContentNotionId: source.notionId,
        pillarContentItemId: source.id,
        sourceClipIdeaId: idea.id,
        hook: pick.hook,
        hookSource: "clip_idea",
        hookExtractedAt: new Date(),
        utmCampaign: await generateUtmCampaign(source.title),
        editorUserId: args.actorUserId,
        createdVia: CLIP_POST_CREATED_VIA,
        angle: args.angle?.trim() || null,
      })
      .returning({ id: productionItems.id });

    await tx.update(clipIdeas).set({ acceptedProductionItemId: item.id }).where(eq(clipIdeas.id, idea.id));
    await tx.insert(clipEdits).values({
      clipIdeaId: idea.id,
      doc: clipPostDoc({ startSec: pick.startSec, endSec: pick.endSec, hook: pick.hook, look: target.clipTemplate }),
      createdByUserId: args.actorUserId,
    });
    // Same dedup marker the manual repurpose leaves, so threshold-monitor-sweep
    // doesn't auto-create a second derivative for this pair.
    await tx.insert(repurposeTriggers).values({ productionItemId: source.id, targetFormatId: target.id, compositionName: target.name });
    return { clipIdeaId: idea.id, productionItemId: item.id, created: true };
  });
  if (!made.created) return made;
  const { productionItemId } = made;

  try {
    await recordItemCreated(db, {
      itemId: productionItemId,
      source: CLIP_POST_CREATED_VIA,
      actorUserId: args.actorUserId,
      format: canonicalFormat,
      sourceType: "repurposed",
      postType,
    });
  } catch (err) {
    console.error("[clip-editor] recordItemCreated failed", err);
  }
  return made;
}

/** The open (not published/killed) post an earlier open made for this pair. */
async function findOpenClipPost(
  q: Pick<typeof db, "select">,
  pillarId: string,
  formatName: string,
): Promise<{ clipIdeaId: string; productionItemId: string } | null> {
  const [row] = await q
    .select({ id: productionItems.id, clipIdeaId: productionItems.sourceClipIdeaId })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.pillarContentItemId, pillarId),
        eq(productionItems.format, formatName),
        eq(productionItems.createdVia, CLIP_POST_CREATED_VIA),
        isNotNull(productionItems.sourceClipIdeaId),
        notInArray(productionItems.status, ["Published", "Killed"]),
        isNull(productionItems.deletedAt),
      ),
    )
    .orderBy(productionItems.createdAt)
    .limit(1);
  return row?.clipIdeaId ? { clipIdeaId: row.clipIdeaId, productionItemId: row.id } : null;
}

function wholeVideoError(formatName: string): ClipPostCreateError {
  return new ClipPostCreateError(`${formatName} posts the whole video — that stays in the classic view for now`, 422, "whole_video");
}

/**
 * The starting edit for a video post on X: landscape, the pillar's footage
 * untouched. The hook and caption layers exist (one click to turn on in the
 * inspector) but start hidden — the pillar already has captions burned in.
 * A saved format look replaces all of that. Exported for the test.
 */
export function clipPostDoc(args: { startSec: number; endSec: number; hook: string; look: unknown }): ClipEditDoc {
  const doc = createDefaultDoc({ startSec: args.startSec, endSec: args.endSec, hook: args.hook, aspectRatio: "16:9" });
  const look = args.look ? clipLookSchema.safeParse(args.look) : null;
  if (look?.success) return applyLook(doc, look.data);
  return { ...doc, layers: doc.layers.map((l) => (l.type === "text" && l.role === "hook") || l.type === "captions" ? { ...l, visible: false } : l) };
}
