// Data the newsletter drafter's agent tools read: the brand's published
// long-form videos in a window, their transcripts, recent starterstory.com
// case studies (Rails content API), and past issues of the format as
// exemplars. All read-only.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import { db } from "@/lib/db";
import { productionItems, transcripts } from "@/lib/db/schema";
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
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    views: r.views,
    hasTranscript: r.transcriptId != null,
  }));
}

export async function getVideoTranscript(
  productionItemId: string,
): Promise<{ text: string; truncated: boolean } | null> {
  const t = await getTranscriptForPrompt(productionItemId);
  if (!t) return null;
  const full = t.fullText || t.segmentsMarkdown;
  const truncated = full.length > TRANSCRIPT_CHAR_BUDGET;
  return { text: truncated ? full.slice(0, TRANSCRIPT_CHAR_BUDGET) : full, truncated };
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
 */
export async function getPastIssues(brand: string, formatName: string): Promise<PastIssue[]> {
  const rows = await db
    .select({
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
    .limit(MAX_EXEMPLARS);

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
