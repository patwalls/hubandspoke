import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { fetchTargetCommonalityForFormat } from "@/lib/services/cross-post-candidates";
import { REACH_WINDOW_DAYS, type ChannelReach } from "@/lib/channel-reach";

/** Each (account, postType) of the brand: its published posts in the last
 *  REACH_WINDOW_DAYS, their median views and how many got no likes. One
 *  grouped scan over the published-date index; ~10–50 rows per brand. */
async function fetchChannelReach(brand: string): Promise<Record<string, ChannelReach>> {
  const rows = await db.execute<{
    account_id: string;
    post_type: string;
    posts: number;
    median_views: number | null;
    zero_likes: number;
  }>(sql`
    SELECT account_id, post_type,
           count(*)::int AS posts,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY views)::float8 AS median_views,
           (count(*) FILTER (WHERE likes = 0))::int AS zero_likes
    FROM production_items
    WHERE brand = ${brand}
      AND status = 'Published'
      AND published_link IS NOT NULL
      AND account_id IS NOT NULL AND post_type IS NOT NULL
      AND published_date >= (now() - make_interval(days => ${REACH_WINDOW_DAYS}))::date
    GROUP BY account_id, post_type`);
  const out: Record<string, ChannelReach> = {};
  for (const r of rows) {
    out[`${r.account_id}:${r.post_type}`] = {
      posts: Number(r.posts),
      medianViews: r.median_views == null ? null : Number(r.median_views),
      zeroLikes: Number(r.zero_likes),
    };
  }
  return out;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where this item's format usually gets cross-posted — the content page's
 * Cross-post tab loads it on open so the panel ranks those targets first and
 * offers "Select usual (N)", the same as the cross-post queue dialog (which
 * gets every format's ranking with the queue payload). Shape matches the
 * queue's `targetCommonality`, keyed by the item's format. Also returns
 * `channelReach` — what each of the brand's targets typically gets (last 30
 * days), shown quietly on each row of the picker.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ targetCommonality: {} });

  const [item] = await db
    .select({ format: productionItems.format, brand: productionItems.brand })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) return NextResponse.json({ targetCommonality: {} });

  const [rows, channelReach] = await Promise.all([
    item.format ? fetchTargetCommonalityForFormat(item.format) : Promise.resolve(null),
    // Reach is a nicety: a failed read draws the picker without it.
    fetchChannelReach(item.brand).catch(() => ({})),
  ]);
  return NextResponse.json({
    targetCommonality: item.format && rows ? { [item.format]: rows } : {},
    channelReach,
  });
}
