// Reads + writes behind the newsletter drafter's API routes.

import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, newsletterDrafts, productionItems, transcripts } from "@/lib/db/schema";
import { templateFor } from "@/lib/newsletter-template";
import { withPillarHeat } from "@/lib/pillar-heat";
import { youtubeIdFrom } from "@/lib/services/design-editor/assets";
import { formatConfigFor } from "./format-config";
import { loadUsage, publishedLabel, usageGroupFor, usageLabel, withInferredSources } from "./usage";
import { computeWindow } from "./window";
import { resolvePendingScreenshots, screenshotPreviewUrls } from "./screenshots";
import { pushView } from "./push-state";

export interface NewsletterFormatOption {
  id: string;
  name: string;
  hasSkill: boolean;
  kind: "roundup" | "single_video";
  /** The sponsored section's name when it comes from a promo calendar. */
  specialLabel: string | null;
}

/**
 * The brand's newsletter formats: any format whose legacy `channels` include
 * "Newsletter", or that has published newsletter items (Daily Seinfeld,
 * Sunday Breakfast, … predate format_channels wiring).
 */
export async function listNewsletterFormats(brand: string): Promise<NewsletterFormatOption[]> {
  const rows = await db
    .select({ id: formats.id, name: formats.name, instructions: formats.instructions })
    .from(formats)
    .where(
      and(
        eq(formats.brand, brand),
        sql`(
          ${formats.channels} @> '["Newsletter"]'::jsonb
          OR EXISTS (
            SELECT 1 FROM ${productionItems}
            WHERE ${productionItems.brand} = ${brand}
              AND ${productionItems.postType} = 'newsletter'
              AND lower(${productionItems.format}) = lower(${formats.name})
          )
        )`,
      ),
    )
    .orderBy(formats.name);
  return rows.map((r) => {
    const cfg = formatConfigFor(r.name);
    return { id: r.id, name: r.name, hasSkill: !!r.instructions?.trim(), kind: cfg.kind, specialLabel: cfg.promo?.label ?? null };
  });
}

const listColumns = {
  id: newsletterDrafts.id,
  formatId: newsletterDrafts.formatId,
  formatName: formats.name,
  status: newsletterDrafts.status,
  subject: newsletterDrafts.subject,
  windowStart: newsletterDrafts.windowStart,
  windowEnd: newsletterDrafts.windowEnd,
  hubspotStatus: newsletterDrafts.hubspotStatus,
  beehiivStatus: newsletterDrafts.beehiivStatus,
  createdAt: newsletterDrafts.createdAt,
};

export async function listNewsletterDrafts(brand: string) {
  return db
    .select(listColumns)
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.brand, brand))
    .orderBy(desc(newsletterDrafts.createdAt))
    .limit(50);
}

export async function getNewsletterDraft(id: string) {
  const [row] = await db
    .select({
      ...listColumns,
      brand: newsletterDrafts.brand,
      sources: newsletterDrafts.sources,
      subjectOptions: newsletterDrafts.subjectOptions,
      previewText: newsletterDrafts.previewText,
      bodyMarkdown: newsletterDrafts.bodyMarkdown,
      notes: newsletterDrafts.notes,
      sendDate: newsletterDrafts.sendDate,
      sourceItemId: newsletterDrafts.sourceItemId,
      specialCopy: newsletterDrafts.specialCopy,
      specialOriginal: newsletterDrafts.specialOriginal,
      specialMode: newsletterDrafts.specialMode,
      specialSource: newsletterDrafts.specialSource,
      specialError: newsletterDrafts.specialError,
      model: newsletterDrafts.model,
      error: newsletterDrafts.error,
      hubspotEmailId: newsletterDrafts.hubspotEmailId,
      hubspotEmailUrl: newsletterDrafts.hubspotEmailUrl,
      hubspotError: newsletterDrafts.hubspotError,
      beehiivPostId: newsletterDrafts.beehiivPostId,
      beehiivPostUrl: newsletterDrafts.beehiivPostUrl,
      beehiivStatus: newsletterDrafts.beehiivStatus,
      beehiivError: newsletterDrafts.beehiivError,
      review: newsletterDrafts.review,
      progress: newsletterDrafts.progress,
      layout: newsletterDrafts.layout,
      variables: newsletterDrafts.variables,
      updatedAt: newsletterDrafts.updatedAt,
      slotKey: newsletterDrafts.slotKey,
      sections: newsletterDrafts.sections,
      screenshots: newsletterDrafts.screenshots,
      revision: newsletterDrafts.revision,
      regenerating: newsletterDrafts.regenerating,
      formatTemplate: formats.newsletterTemplate,
      sourceTitle: sql<string | null>`(SELECT ${productionItems.title} FROM ${productionItems} WHERE ${productionItems.id} = ${newsletterDrafts.sourceItemId})`,
      sourceUrl: sql<string | null>`(SELECT COALESCE(${productionItems.publishedLink}, ${productionItems.youtubeUrl}) FROM ${productionItems} WHERE ${productionItems.id} = ${newsletterDrafts.sourceItemId})`,
    })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, id))
    .limit(1);
  if (!row) return null;
  const { formatTemplate, ...pushed } = row;
  // A push the worker never finished reads as failed, so the editor can retry (push-state.ts).
  const hs = pushView(row.hubspotStatus, row.hubspotError, row.updatedAt, Date.now(), "HubSpot");
  const bh = pushView(row.beehiivStatus, row.beehiivError, row.updatedAt, Date.now(), "beehiiv");
  const rest = { ...pushed, hubspotStatus: hs.status, hubspotError: hs.error, beehiivStatus: bh.status, beehiivError: bh.error };
  const config = formatConfigFor(row.formatName);
  // Drafts written before the agent filled `source` get it from their links.
  const sections = config.kind === "roundup" ? withInferredSources(row.sections, row.sources) : row.sections;
  // "N× before" for every section's story (this draft excluded from its own counts).
  const withSources = sections.filter((x) => x.source?.key);
  const usage = withSources.length ? await loadUsage(usageGroupFor(row.formatName), { excludeDraftId: row.id }) : null;
  // Publish dates: videos from production_items (covers older drafts too); case studies from the stored source.
  const videoIds = withSources.filter((x) => x.source!.kind === "video").map((x) => x.source!.key.slice("video:".length));
  const videoDates = new Map<string, string | null>();
  if (videoIds.length) {
    const rows = await db
      .select({
        id: productionItems.id,
        at: sql<string | null>`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`,
      })
      .from(productionItems)
      .where(inArray(productionItems.id, videoIds));
    for (const r of rows) videoDates.set(`video:${r.id}`, r.at ? new Date(r.at).toISOString() : null);
  }
  const sectionUsage: Record<string, { count: number; lastDate: string | null; label: string; published: string | null }> = {};
  for (const sec of withSources) {
    const u = usage?.get(sec.source!.key);
    const at = videoDates.get(sec.source!.key) ?? sec.source!.publishedAt ?? null;
    sectionUsage[sec.key] = { count: u?.count ?? 0, lastDate: u?.lastDate ?? null, label: usageLabel(u), published: publishedLabel(at) };
  }
  return {
    ...rest,
    sections,
    screenshotPreviews: await screenshotPreviewUrls(await resolvePendingScreenshots(row.id, row.screenshots)),
    specialLabel: config.promo?.label ?? null,
    kind: config.kind,
    template: templateFor(row.formatName, formatTemplate),
    sectionUsage,
  };
}

/** How far back the video picker looks for a single_video format. */
const VIDEO_PICKER_DAYS = 45;

export interface FormatVideoOption {
  id: string;
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  hasTranscript: boolean;
  /** For the picker's thumbnail and watch-it preview; null without a YouTube link. */
  youtubeId: string | null;
  /** The YouTube channel's handle (a brand can have several). */
  channel: string | null;
  views: number | null;
  leads: number | null;
  /** Views ÷ the channel's median in this list (`withPillarHeat`). */
  heat: number | null;
}

async function sourceAccountIds(formatName: string): Promise<string[]> {
  const handles = (formatConfigFor(formatName).sources ?? []).map((x) => x.handle.toLowerCase());
  if (!handles.length) return [];
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.platform, "youtube"), inArray(sql`lower(${accounts.handle})`, handles)));
  return rows.map((r) => r.id);
}

/** Published long-form videos matching `where`, newest first, with what the pillar picker shows. */
async function listPillarVideos(where: SQL, days: number, limit: number): Promise<FormatVideoOption[]> {
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      youtubeId: productionItems.youtubeId,
      publishedAt: sql<string | null>`${published}`,
      transcriptId: transcripts.id,
      accountId: productionItems.accountId,
      channel: accounts.handle,
      views: productionItems.views,
      leads: productionItems.leads,
    })
    .from(productionItems)
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(
      and(
        where,
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} > now() - make_interval(days => ${days})`,
      ),
    )
    .orderBy(desc(published))
    .limit(limit);
  return withPillarHeat(rows).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    hasTranscript: r.transcriptId != null,
    youtubeId: r.youtubeId ?? youtubeIdFrom(r.youtubeUrl) ?? youtubeIdFrom(r.publishedLink),
    channel: r.channel,
    views: r.views,
    leads: r.leads,
    heat: r.heat,
  }));
}

/** Recent published long-form videos from a single_video format's source channels, newest first. */
export async function listFormatVideos(formatId: string): Promise<FormatVideoOption[] | null> {
  const [format] = await db.select({ name: formats.name }).from(formats).where(eq(formats.id, formatId)).limit(1);
  if (!format) return null;
  const accountIds = await sourceAccountIds(format.name);
  if (!accountIds.length) return [];
  return listPillarVideos(inArray(productionItems.accountId, accountIds), VIDEO_PICKER_DAYS, 30);
}

/** The brand's published long-form videos from the last 90 days (any channel), newest first — the pillar picker for "one piece of pillar content". */
export async function listBrandVideos(brand: string): Promise<FormatVideoOption[]> {
  return listPillarVideos(eq(productionItems.brand, brand), 90, 40);
}

/**
 * The pillar video an edition is drafted from, checked against its format: a
 * How-To needs one of its own channels' videos; a roundup MAY be about one of
 * the brand's long-form videos (with a transcript). null = a roundup the
 * drafter assembles itself.
 */
async function resolvePillarSource(
  format: { brand: string; name: string },
  sourceItemId: string | null | undefined,
): Promise<{ sourceItemId: string | null } | { error: string }> {
  if (formatConfigFor(format.name).kind === "single_video") {
    if (!sourceItemId) return { error: "Pick a video for this format" };
    // Only videos from the format's own channels are valid sources.
    const accountIds = await sourceAccountIds(format.name);
    const [item] = await db
      .select({ accountId: productionItems.accountId })
      .from(productionItems)
      .where(eq(productionItems.id, sourceItemId))
      .limit(1);
    if (!item || !item.accountId || !accountIds.includes(item.accountId)) return { error: "That video isn't from this format's channels" };
    return { sourceItemId };
  }
  if (!sourceItemId) return { sourceItemId: null };
  // A roundup format about ONE piece of pillar content: any of the brand's long-form videos with a transcript.
  const [item] = await db
    .select({ brand: productionItems.brand, postType: productionItems.postType, transcriptId: transcripts.id })
    .from(productionItems)
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(eq(productionItems.id, sourceItemId))
    .limit(1);
  if (!item || item.brand !== format.brand || item.postType !== "youtube_long") return { error: "That isn't one of this brand's videos" };
  if (!item.transcriptId) return { error: "That video has no transcript yet" };
  return { sourceItemId };
}

export async function createNewsletterDraft(args: {
  formatId: string;
  days?: number | null;
  notes?: string | null;
  sendDate?: string | null;
  sourceItemId?: string | null;
  userId: string | null;
}): Promise<{ id: string; brand: string } | { error: string } | null> {
  const [format] = await db
    .select({ id: formats.id, brand: formats.brand, name: formats.name })
    .from(formats)
    .where(eq(formats.id, args.formatId))
    .limit(1);
  if (!format) return null;
  const source = await resolvePillarSource(format, args.sourceItemId);
  if ("error" in source) return source;
  const { sourceItemId } = source;
  const w = computeWindow(args.days);
  const [created] = await db
    .insert(newsletterDrafts)
    .values({
      brand: format.brand,
      formatId: format.id,
      status: "drafting",
      windowStart: w.start,
      windowEnd: w.end,
      notes: args.notes?.trim() || null,
      sendDate: args.sendDate ?? null,
      sourceItemId,
      // Pinned by the editor: the issue is about this one piece (roundup formats); the How-To's video is always its source.
      sourcePinned: !!sourceItemId,
      createdByUserId: args.userId,
    })
    .returning({ id: newsletterDrafts.id });
  return { id: created.id, brand: format.brand };
}

/**
 * Draft (or redraft) an existing edition — a scheduled slot from the queue or
 * the board: flip it to `drafting`. Opening a slot from the queue first asks
 * for its PILLAR (`sourceItemId`: a video, or null for a roundup the drafter
 * assembles) and ANGLE (`notes`); either left undefined keeps what the row has.
 * The queue item's pillar follows the chosen video. The caller enqueues the run.
 */
export async function startEditionDraft(args: {
  id: string;
  notes?: string | null;
  sourceItemId?: string | null;
  userId: string | null;
}): Promise<{ ok: true } | { error: string; status: 400 | 404 | 409 }> {
  const [row] = await db
    .select({ brand: formats.brand, name: formats.name, productionItemId: newsletterDrafts.productionItemId })
    .from(newsletterDrafts)
    .innerJoin(formats, eq(formats.id, newsletterDrafts.formatId))
    .where(eq(newsletterDrafts.id, args.id))
    .limit(1);
  if (!row) return { error: "Not found", status: 404 };
  let pillar: { sourceItemId: string | null; sourcePinned: boolean } | null = null;
  if (args.sourceItemId !== undefined) {
    const source = await resolvePillarSource(row, args.sourceItemId);
    if ("error" in source) return { ...source, status: 400 };
    pillar = { sourceItemId: source.sourceItemId, sourcePinned: !!source.sourceItemId };
  }
  const [updated] = await db
    .update(newsletterDrafts)
    .set({
      status: "drafting",
      error: null,
      regenerating: [],
      ...(args.notes !== undefined ? { notes: args.notes?.trim() || null } : {}),
      ...(pillar ?? {}),
      createdByUserId: args.userId,
      updatedAt: new Date(),
    })
    .where(and(eq(newsletterDrafts.id, args.id), inArray(newsletterDrafts.status, ["idea", "failed", "ready"])))
    .returning({ id: newsletterDrafts.id });
  if (!updated) return { error: "Already drafting, or not found", status: 409 };
  if (pillar && row.productionItemId) {
    await db
      .update(productionItems)
      .set({ pillarContentItemId: pillar.sourceItemId, updatedAt: new Date() })
      .where(eq(productionItems.id, row.productionItemId));
  }
  return { ok: true };
}
