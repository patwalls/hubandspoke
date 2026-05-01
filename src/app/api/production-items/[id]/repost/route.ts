import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { buildRepostValues } from "@/lib/services/repost-values";
import { generateUtmCampaign } from "@/lib/utm-campaign";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/repost
 *
 * Creates a new `repost` production item that mirrors the source on the same
 * platform(s). Inherits title, thumbnail, format, pillar, and brand from the
 * source. Status starts as "Idea". Multiple reposts of the same source are
 * allowed (you might repost the same content several times).
 */
export async function POST(_request: Request, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  const [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  // Legacy/oddball items pre-date the accounts rollout — they don't have an
  // accountId/postType and aren't repost-eligible until backfilled.
  if (!source.accountId || !source.postType) {
    return NextResponse.json(
      { error: "Source item is missing accountId or postType — backfill required before reposting." },
      { status: 422 }
    );
  }

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: source.format,
  });

  const [created] = await db
    .insert(productionItems)
    .values(
      buildRepostValues(
        {
          id: source.id,
          brand: source.brand,
          title: source.title,
          thumbnail: source.thumbnail,
          accountId: source.accountId,
          postType: source.postType,
          platform: source.platform,
          format: source.format,
          pillarContentItemId: source.pillarContentItemId,
          pillarContentNotionId: source.pillarContentNotionId,
        },
        {
          utmCampaign: await generateUtmCampaign(source.title),
          producerUserId: assignees.producerUserId,
          editorUserId: assignees.editorUserId,
        }
      )
    )
    .returning({ id: productionItems.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
