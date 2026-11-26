/**
 * Reads for the Monday winners email (milestone 4): every enabled brand's
 * strip winners (last 7 days), format scoreboard (last 28 days) and quiet
 * channels (last 30 days, most posts got no likes). Rendering
 * rules are in `src/lib/winners/email.ts`; the send is the `winners-email`
 * task. Brand reads are shared across recipients — only the greeting differs.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { brands, users } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getFormatScoreboard, getRecentWinners } from "@/lib/db/winners";
import type { WinnersEmailBrand } from "@/lib/winners/email";
import { quietChannels, REACH_WINDOW_DAYS, type QuietChannelRow } from "@/lib/channel-reach";

/** Each (account, postType) of the brand over the last REACH_WINDOW_DAYS:
 *  published posts and how many got no likes — the same window and rule as
 *  the cross-post picker's reach label — filtered to the quiet ones. */
export async function getQuietChannels(brand: string): Promise<QuietChannelRow[]> {
  const rows = await db.execute<{
    handle: string;
    post_type: string;
    posts: number;
    median_views: number | null;
    zero_likes: number;
  }>(sql`
    SELECT a.handle, p.post_type,
           count(*)::int AS posts,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY p.views)::float8 AS median_views,
           (count(*) FILTER (WHERE p.likes = 0))::int AS zero_likes
    FROM production_items p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.brand = ${brand}
      AND p.status = 'Published'
      AND p.published_link IS NOT NULL
      AND p.post_type IS NOT NULL
      AND p.published_date >= (now() - make_interval(days => ${REACH_WINDOW_DAYS}))::date
    GROUP BY a.handle, p.post_type`);
  return quietChannels(
    rows.map((r) => ({
      handle: r.handle,
      postType: r.post_type,
      posts: Number(r.posts),
      medianViews: r.median_views == null ? null : Number(r.median_views),
      zeroLikes: Number(r.zero_likes),
    })),
  );
}

export async function loadWinnersEmailBrands(): Promise<WinnersEmailBrand[]> {
  const rows = await db
    .select({ slug: brands.slug, label: brands.label })
    .from(brands)
    .where(eq(brands.disabled, false))
    .orderBy(asc(brands.label));
  const out: WinnersEmailBrand[] = [];
  for (const b of rows) {
    const [winners, formats, quiet] = await Promise.all([
      getRecentWinners(b.slug),
      getFormatScoreboard(b.slug),
      getQuietChannels(b.slug),
    ]);
    out.push({ slug: b.slug, label: b.label, winners, formats, quiet });
  }
  return out;
}

export function firstNameOf(name: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** Who gets Monday's email: active people with the `winnersEmail` flag who
 *  haven't turned it off on /winners-email. */
export async function loadWinnersEmailRecipients(): Promise<{ id: string; email: string; name: string | null }[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(isNull(users.deactivatedAt), eq(users.winnersEmailEnabled, true)));
  return rows.filter((u) => isFeatureEnabled("winnersEmail", u));
}
