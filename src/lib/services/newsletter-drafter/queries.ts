// Reads + writes behind the newsletter drafter's API routes.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, formats, newsletterDrafts, productionItems, transcripts } from "@/lib/db/schema";
import { templateFor } from "@/lib/newsletter-template";
import { formatConfigFor } from "./format-config";
import { loadUsage, publishedLabel, usageGroupFor, usageLabel, withInferredSources } from "./usage";
import { computeWindow } from "./window";
import { resolvePendingScreenshots, screenshotPreviewUrls } from "./screenshots";

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
  const { formatTemplate, ...rest } = row;
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

/** Recent published long-form videos from a single_video format's source channels, newest first. */
export async function listFormatVideos(formatId: string): Promise<FormatVideoOption[] | null> {
  const [format] = await db.select({ name: formats.name }).from(formats).where(eq(formats.id, formatId)).limit(1);
  if (!format) return null;
  const accountIds = await sourceAccountIds(format.name);
  if (!accountIds.length) return [];
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      publishedAt: sql<string | null>`${published}`,
      transcriptId: transcripts.id,
    })
    .from(productionItems)
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        inArray(productionItems.accountId, accountIds),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} > now() - (${VIDEO_PICKER_DAYS} || ' days')::interval`,
      ),
    )
    .orderBy(desc(published))
    .limit(30);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    hasTranscript: r.transcriptId != null,
  }));
}

/** The brand's published long-form videos from the last 90 days (any channel), newest first — the pillar picker for "one piece of pillar content". */
export async function listBrandVideos(brand: string): Promise<FormatVideoOption[]> {
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      publishedAt: sql<string | null>`${published}`,
      transcriptId: transcripts.id,
    })
    .from(productionItems)
    .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${published} > now() - interval '90 days'`,
      ),
    )
    .orderBy(desc(published))
    .limit(40);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    hasTranscript: r.transcriptId != null,
  }));
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
  let sourceItemId: string | null = null;
  if (formatConfigFor(format.name).kind === "single_video") {
    if (!args.sourceItemId) return { error: "Pick a video for this format" };
    // Only videos from the format's own channels are valid sources.
    const accountIds = await sourceAccountIds(format.name);
    const [item] = await db
      .select({ accountId: productionItems.accountId })
      .from(productionItems)
      .where(eq(productionItems.id, args.sourceItemId))
      .limit(1);
    if (!item || !item.accountId || !accountIds.includes(item.accountId)) return { error: "That video isn't from this format's channels" };
    sourceItemId = args.sourceItemId;
  } else if (args.sourceItemId) {
    // A roundup format about ONE piece of pillar content: any of the brand's long-form videos with a transcript.
    const [item] = await db
      .select({ brand: productionItems.brand, postType: productionItems.postType, transcriptId: transcripts.id })
      .from(productionItems)
      .leftJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
      .where(eq(productionItems.id, args.sourceItemId))
      .limit(1);
    if (!item || item.brand !== format.brand || item.postType !== "youtube_long") return { error: "That isn't one of this brand's videos" };
    if (!item.transcriptId) return { error: "That video has no transcript yet" };
    sourceItemId = args.sourceItemId;
  }
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
