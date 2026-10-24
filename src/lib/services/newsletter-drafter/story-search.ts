// "Find new story": the stories an editor can put in a roundup section — a
// type-ahead search over the brand's long-form videos (title) and, for
// brands with case studies, starterstory.com case studies (content API), and
// with no query a short list of good recommendations: this window's and the
// last 30 days' videos and the newest case studies, ones this newsletter
// hasn't run recently and no other section of the issue uses. Each carries
// how often the newsletter ran it, so the picker can say "Never featured".
// Read-only.

import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import type { NewsletterSection } from "@/lib/newsletter-template";
import { brandHasCaseStudies } from "./format-config";
import { listRecentCaseStudies, searchCaseStudies, youtubeThumbnailUrl } from "./sources";
import { blockedKeys, caseStudyKey, loadUsage, usageGroupFor } from "./usage";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECOMMEND_VIDEO_DAYS = 30;
const RECOMMEND_CASE_DAYS = 21;
const LIMIT = 10;

export interface StoryOption {
  kind: "video" | "case_study";
  key: string;
  title: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  /** Case studies: the business, for a line under the title. */
  subtitle: string | null;
  productionItemId: string | null;
  timesRun: number;
  lastRun: string | null;
  /** Ran in this newsletter too recently to use again. */
  blocked: boolean;
  /** Another section of this issue already covers it. */
  inIssue: boolean;
}

async function videos(brand: string, opts: { q?: string; sinceDays?: number }) {
  const published = sql`COALESCE(${productionItems.publishedAt}, ${productionItems.publishedDate}::timestamptz)`;
  return db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      url: sql<string | null>`COALESCE(${productionItems.publishedLink}, ${productionItems.youtubeUrl})`,
      youtubeId: productionItems.youtubeId,
      publishedAt: sql<string | null>`${published}`,
    })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.brand, brand),
        eq(productionItems.postType, "youtube_long"),
        eq(productionItems.status, "Published"),
        isNull(productionItems.deletedAt),
        opts.q ? ilike(productionItems.title, `%${opts.q.replace(/[%_\\]/g, "\\$&")}%`) : undefined,
        opts.sinceDays ? sql`${published} > now() - (${opts.sinceDays} || ' days')::interval` : undefined,
      ),
    )
    .orderBy(desc(published))
    .limit(LIMIT);
}

/** Stories for a draft's "Find new story" picker: matches for `q`, else recommendations. */
export async function listStoryOptions(args: { brand: string; formatName: string; draftId: string; sendDate: string | null; sections: NewsletterSection[]; q?: string | null }): Promise<StoryOption[]> {
  const q = args.q?.trim() || null;
  const usage = await loadUsage(usageGroupFor(args.formatName), { excludeDraftId: args.draftId });
  const blocked = blockedKeys(usage, args.sendDate);
  const inIssue = new Set(args.sections.map((s) => s.source?.key).filter(Boolean) as string[]);
  const withCases = brandHasCaseStudies(args.brand);
  const now = Date.now();
  const [vids, cases] = await Promise.all([
    videos(args.brand, q ? { q } : { sinceDays: RECOMMEND_VIDEO_DAYS }),
    withCases
      ? (q ? searchCaseStudies(q) : listRecentCaseStudies({ start: new Date(now - RECOMMEND_CASE_DAYS * DAY_MS), end: new Date(now) })).catch(() => [])
      : Promise.resolve([]),
  ]);
  const opt = (o: Omit<StoryOption, "timesRun" | "lastRun" | "blocked" | "inIssue">): StoryOption => {
    const u = usage.get(o.key);
    return { ...o, timesRun: u?.count ?? 0, lastRun: u?.lastDate ?? null, blocked: blocked.has(o.key), inIssue: inIssue.has(o.key) };
  };
  const out: StoryOption[] = [
    ...vids.map((v) =>
      opt({ kind: "video", key: `video:${v.id}`, title: v.title, url: v.url, thumbnailUrl: youtubeThumbnailUrl(v.youtubeId), publishedAt: v.publishedAt ? new Date(v.publishedAt).toISOString() : null, subtitle: null, productionItemId: v.id }),
    ),
    ...cases.flatMap((c) => {
      const key = caseStudyKey(c.url);
      return key ? [opt({ kind: "case_study", key, title: c.title, url: c.url, thumbnailUrl: null, publishedAt: c.publishedAt, subtitle: c.businessName, productionItemId: null })] : [];
    }),
  ];
  // Recommendations leave out what can't or shouldn't be used; a search shows everything (marked).
  const list = q ? out : out.filter((o) => !o.blocked && !o.inIssue);
  return list.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, q ? 2 * LIMIT : LIMIT);
}
