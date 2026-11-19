import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { fetchTargetCommonalityForFormat } from "@/lib/services/cross-post-candidates";
import { fetchChannelReach } from "@/lib/channel-reach-query";

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
