import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { generateUtmCampaign } from "@/lib/utm-campaign";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/duplicate
 *
 * Clones the structural fields of an existing production item into a new
 * "Idea"-status row. Copies platform, format, pillar, brand, and assignees.
 * Does NOT copy anything tied to the specific published instance: the
 * published link, publish date, metrics, enrichment state, or source-type
 * lineage. The new item is a plain `original` waiting to be produced.
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

  const title = source.title ? `${source.title} (copy)` : "(copy)";

  const [created] = await db
    .insert(productionItems)
    .values({
      brand: source.brand,
      title,
      thumbnail: source.thumbnail,
      status: "Idea",
      platform: source.platform,
      sourceType: "original",
      format: source.format,
      pillarContentNotionId: source.pillarContentNotionId,
      pillarContentItemId: source.pillarContentItemId,
      utmCampaign: await generateUtmCampaign(title),
      producerUserId: source.producerUserId,
      editorUserId: source.editorUserId,
    })
    .returning({ id: productionItems.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
