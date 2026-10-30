/**
 * GET /api/v1/transcripts/search — Postgres full-text search over
 * `transcripts.full_text` (GIN index `idx_transcripts_fulltext`). Each hit
 * carries a highlighted snippet and the timestamp of the first segment that
 * contains the query's words, so a caller can deep-link into the video.
 */
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, productionItems, transcripts } from "@/lib/db/schema";
import { ApiError } from "./http";

export interface TranscriptHit {
  content_id: string;
  title: string | null;
  brand: string;
  post_type: string | null;
  account: string | null;
  url: string | null;
  published_at: string | null;
  app_url: string;
  rank: number;
  snippet: string;
  /** First segment whose text contains all the query words; null when the match straddles segments. */
  at_sec: number | null;
  at_text: string | null;
}

export interface TranscriptSearchParams {
  q: string;
  brand?: string;
  limit?: number;
}

function words(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 1);
}

/** Locate the first segment containing every query word (case-insensitive). Pure; unit-tested. */
export function locateInSegments(
  segments: Array<{ startSec: number; text: string }>,
  q: string,
): { startSec: number; text: string } | null {
  const terms = words(q);
  if (!terms.length) return null;
  for (const s of segments) {
    const t = s.text.toLowerCase();
    if (terms.every((w) => t.includes(w))) return { startSec: s.startSec, text: s.text.trim() };
  }
  // Fall back to the first segment that has any of the terms, longest term first.
  const byLength = [...terms].sort((a, b) => b.length - a.length);
  for (const w of byLength) {
    const hit = segments.find((s) => s.text.toLowerCase().includes(w));
    if (hit) return { startSec: hit.startSec, text: hit.text.trim() };
  }
  return null;
}

export async function searchTranscripts(params: TranscriptSearchParams, baseUrl: string): Promise<{ data: TranscriptHit[] }> {
  const q = params.q.trim();
  if (q.length < 2) throw new ApiError("invalid_request", "q must be at least 2 characters.");
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
  const tsquery = sql`websearch_to_tsquery('english', ${q})`;
  const vector = sql`to_tsvector('english', ${transcripts.fullText})`;
  const where: SQL[] = [isNull(productionItems.deletedAt), sql`${vector} @@ ${tsquery}`];
  if (params.brand && params.brand !== "all") where.push(eq(productionItems.brand, params.brand));

  const rows = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      brand: productionItems.brand,
      postType: productionItems.postType,
      publishedLink: productionItems.publishedLink,
      publishedAt: productionItems.publishedAt,
      publishedDate: productionItems.publishedDate,
      handle: accounts.handle,
      platform: accounts.platform,
      segments: transcripts.segments,
      rank: sql<number>`ts_rank_cd(${vector}, ${tsquery})`,
      snippet: sql<string>`ts_headline('english', ${transcripts.fullText}, ${tsquery}, 'MaxWords=40, MinWords=20, StartSel=**, StopSel=**')`,
    })
    .from(transcripts)
    .innerJoin(productionItems, eq(productionItems.id, transcripts.productionItemId))
    .leftJoin(accounts, eq(accounts.id, productionItems.accountId))
    .where(and(...where))
    .orderBy(desc(sql`ts_rank_cd(${vector}, ${tsquery})`))
    .limit(limit);

  return {
    data: rows.map((r) => {
      const at = locateInSegments(r.segments ?? [], q);
      const publishedAt = r.publishedAt ?? (r.publishedDate ? new Date(`${r.publishedDate}T00:00:00Z`) : null);
      return {
        content_id: r.id,
        title: r.title,
        brand: r.brand,
        post_type: r.postType,
        account: r.handle ? `${r.platform}/@${r.handle}` : null,
        url: r.publishedLink,
        published_at: publishedAt ? publishedAt.toISOString() : null,
        app_url: `${baseUrl}/${r.brand}/content/${r.id}`,
        rank: Number(r.rank),
        snippet: r.snippet,
        at_sec: at?.startSec ?? null,
        at_text: at?.text ?? null,
      };
    }),
  };
}
