// Data the newsletter drafter's agent tools read: the brand's published
// long-form videos in a window, their transcripts, recent starterstory.com
// case studies (Rails content API), and past issues of the format as
// exemplars. All read-only.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import { db } from "@/lib/db";
import { accounts, productionItems, transcripts } from "@/lib/db/schema";
import { searchContent, type ContentResult } from "@/lib/services/starter-story-content";
import { getTranscriptForPrompt } from "@/lib/services/whisper-transcribe";
import { isWithinWindow, type DraftWindow } from "./window";

/** Per-transcript cap so one long interview can't crowd out the rest. */
export const TRANSCRIPT_CHAR_BUDGET = 60_000;
/** Per-exemplar cap — exemplars are for voice + structure, not content. */
const EXEMPLAR_CHAR_BUDGET = 8_000;
const MAX_EXEMPLARS = 6;
/** The content API's MAX_LIMIT; results come back newest first. */
const CASE_STUDY_FETCH_LIMIT = 25;

export interface RecentVideo {
  productionItemId: string;
  title: string | null;
  url: string | null;
  /** For sections whose template asks for the video thumbnail. */
  thumbnailUrl: string | null;
  publishedAt: string | null;
  views: number | null;
  hasTranscript: boolean;
}

export async function listRecentVideos(brand: string, w: DraftWindow): Promise<RecentVideo[]> {
  const effectivePublishedAt = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      youtubeId: productionItems.youtubeId,
      publishedAt: sql<string | null>`${effectivePublishedAt}`,
      views: productionItems.views,
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
        sql`${effectivePublishedAt} >= ${w.start.toISOString()}::timestamptz`,
        sql`${effectivePublishedAt} <= ${w.end.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(effectivePublishedAt));

  return rows.map((r) => ({
    productionItemId: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    thumbnailUrl: youtubeThumbnailUrl(r.youtubeId),
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    views: r.views,
    hasTranscript: r.transcriptId != null,
  }));
}

export async function getVideoTranscript(
  productionItemId: string,
  budget: number = TRANSCRIPT_CHAR_BUDGET,
): Promise<{ text: string; truncated: boolean } | null> {
  const t = await getTranscriptForPrompt(productionItemId);
  if (!t) return null;
  const full = t.fullText || t.segmentsMarkdown;
  const truncated = full.length > budget;
  return { text: truncated ? full.slice(0, budget) : full, truncated };
}

/**
 * The transcript with a [M:SS] timestamp on every line (the How-To drafter
 * tags each screenshot placeholder with the moment it shows, so Hub & Spoke
 * can grab that frame from the archived video). Falls back to plain text.
 */
export async function getTimestampedTranscript(
  productionItemId: string,
  budget: number,
): Promise<{ text: string; truncated: boolean; timestamped: boolean } | null> {
  const t = await getTranscriptForPrompt(productionItemId);
  if (!t) return null;
  const timestamped = !!t.segmentsMarkdown.trim();
  const full = timestamped ? t.segmentsMarkdown : t.fullText;
  const truncated = full.length > budget;
  return { text: truncated ? full.slice(0, budget) : full, truncated, timestamped };
}

/** A How-To issue is written from one whole video, so allow a much longer transcript. */
export const SINGLE_VIDEO_TRANSCRIPT_BUDGET = 200_000;

/** YouTube thumbnail for a video id (maxres; YouTube serves hqdefault-sized art when maxres is missing). Exported for tests. */
export function youtubeThumbnailUrl(youtubeId: string | null): string | null {
  return youtubeId ? `https://img.youtube.com/vi/${youtubeId}/maxresdefault.jpg` : null;
}

export interface SingleVideo {
  productionItemId: string;
  title: string | null;
  url: string | null;
  youtubeId: string | null;
  publishedAt: string | null;
  accountId: string | null;
  /** The channel the video is on (picks Kevin's vs Saj's voice). */
  channelHandle: string | null;
}

export async function getSingleVideo(productionItemId: string): Promise<SingleVideo | null> {
  const [r] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      youtubeId: productionItems.youtubeId,
      publishedAt: sql<string | null>`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`,
      accountId: productionItems.accountId,
      channelHandle: sql<string | null>`(SELECT ${accounts.handle} FROM ${accounts} WHERE ${accounts.id} = ${productionItems.accountId})`,
    })
    .from(productionItems)
    .where(eq(productionItems.id, productionItemId))
    .limit(1);
  if (!r) return null;
  return {
    productionItemId: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    youtubeId: r.youtubeId,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    accountId: r.accountId,
    channelHandle: r.channelHandle,
  };
}

/** Filter content-API results to the window. Exported for tests. */
export function caseStudiesInWindow(results: ContentResult[], w: DraftWindow): ContentResult[] {
  return results.filter((r) => r.url && isWithinWindow(r.publishedAt, w));
}

/** Newest Starter Story interviews + breakdowns (the case studies on /explore). */
export async function listRecentCaseStudies(w: DraftWindow): Promise<ContentResult[]> {
  const results = await searchContent({ limit: CASE_STUDY_FETCH_LIMIT });
  return caseStudiesInWindow(results, w);
}

export interface PastIssue {
  subject: string | null;
  previewText: string | null;
  body: string;
  publishedAt: string | null;
  views: number | null;
}

/** HTML → plain text for exemplar prompts (structural strip, not content analysis). */
export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html.replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "$&\n"), {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Most recent published issues of a newsletter format — the voice/structure
 * anchor. Deliberately NOT `getTopPerformingCaptions`: that one has a
 * freshness cutoff (newsletter rows stopped syncing with Klaviyo) and an
 * on-demand enrichment hop we don't want here.
 * `voice` (one-video formats with two voices, e.g. Kevin / Saj): issues by that
 * author (author_display_name) first, then unattributed ones (beehiiv only
 * started recording bylines in Oct 2026), never the other voice's, unless
 * that leaves fewer than 2.
 */
export async function getPastIssues(brand: string, formatName: string, voice?: string | null): Promise<PastIssue[]> {
  const all = await db
    .select({
      author: productionItems.authorDisplayName,
      title: productionItems.title,
      previewText: productionItems.newsletterPreviewText,
      contentBody: productionItems.contentBody,
      html: productionItems.newsletterBodyHtml,
      publishedAt: productionItems.publishedAt,
      views: productionItems.views,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, "newsletter"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`lower(${productionItems.format}) = lower(${formatName})`,
        sql`(
          (${productionItems.contentBody} IS NOT NULL AND length(trim(${productionItems.contentBody})) > 0)
          OR (${productionItems.newsletterBodyHtml} IS NOT NULL AND length(trim(${productionItems.newsletterBodyHtml})) > 0)
        )`,
      ),
    )
    .orderBy(desc(productionItems.publishedAt))
    .limit(voice ? MAX_EXEMPLARS * 4 : MAX_EXEMPLARS);
  const mine = (r: (typeof all)[number]) => (r.author ?? "").toLowerCase().includes(voice!.toLowerCase());
  const ok = voice ? [...all.filter(mine), ...all.filter((r) => !r.author?.trim())] : all;
  const rows = (ok.length >= 2 ? ok : all).slice(0, MAX_EXEMPLARS);

  return rows.map((r) => {
    const body = r.html?.trim() ? htmlToPlainText(r.html) : (r.contentBody ?? "").trim();
    return {
      subject: r.title,
      previewText: r.previewText,
      body: body.slice(0, EXEMPLAR_CHAR_BUDGET),
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      views: r.views,
    };
  });
}

/**
 * The brand's older published long-form videos (published before `before`),
 * most-viewed first — candidates when a week is short on new stories. The
 * caller filters out anything run recently (usage.ts).
 */
export async function listOlderVideos(brand: string, before: Date, limit = 120): Promise<RecentVideo[]> {
  const effectivePublishedAt = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      publishedLink: productionItems.publishedLink,
      youtubeUrl: productionItems.youtubeUrl,
      youtubeId: productionItems.youtubeId,
      publishedAt: sql<string | null>`${effectivePublishedAt}`,
      views: productionItems.views,
    })
    .from(productionItems)
    .innerJoin(transcripts, eq(transcripts.productionItemId, productionItems.id))
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        sql`${effectivePublishedAt} < ${before.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(sql`${productionItems.views} DESC NULLS LAST`)
    .limit(limit);
  return rows.map((r) => ({
    productionItemId: r.id,
    title: r.title,
    url: r.publishedLink ?? r.youtubeUrl,
    thumbnailUrl: youtubeThumbnailUrl(r.youtubeId),
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    views: r.views,
    hasTranscript: true,
  }));
}

/** Search the whole Starter Story case-study catalog by topic / business / founder (content API title search). */
export async function searchCaseStudies(query: string): Promise<ContentResult[]> {
  return (await searchContent({ q: query, limit: 25 })).filter((r) => r.url);
}
