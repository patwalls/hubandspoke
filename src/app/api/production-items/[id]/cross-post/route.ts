import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { isNotionAuthoritative } from "@/lib/platform";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/cross-post
 *
 * Body: { targetPlatform: string }
 *
 * Creates a new `cross_post` production item from the source item for the
 * given target platform. Inherits title, thumbnail, format, pillar, and brand
 * from the source. Status starts as "Idea". Returns the new item id so the
 * client can redirect to the detail page.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 }
    );
  }

  const targetPlatform =
    typeof (body as { targetPlatform?: unknown }).targetPlatform === "string"
      ? (body as { targetPlatform: string }).targetPlatform.trim()
      : "";

  if (!targetPlatform) {
    return NextResponse.json(
      { error: "targetPlatform is required" },
      { status: 400 }
    );
  }

  if (isNotionAuthoritative([targetPlatform])) {
    return NextResponse.json(
      {
        error:
          "Target is a Notion-authoritative format; create that post in Notion instead.",
      },
      { status: 400 }
    );
  }

  const [source] = await db
    .select()
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json({ error: "Source item not found" }, { status: 404 });
  }

  const sourcePlatforms = (source.platform ?? []) as string[];
  if (sourcePlatforms.includes(targetPlatform)) {
    return NextResponse.json(
      { error: "Source is already on the target platform" },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(
      and(
        eq(productionItems.sourceType, "cross_post"),
        eq(productionItems.repostedFromItemId, source.id),
        sql`${productionItems.platform} ? ${targetPlatform}`
      )
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: "A cross-post for this target platform already exists", existingId: existing.id },
      { status: 409 }
    );
  }

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: source.format,
  });

  const [created] = await db
    .insert(productionItems)
    .values({
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      status: "Idea",
      platform: [targetPlatform],
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      format: source.format,
      pillarContentNotionId: source.pillarContentNotionId,
      pillarContentItemId: source.pillarContentItemId,
      utmCampaign: await generateUtmCampaign(source.title),
      producerUserId: assignees.producerUserId,
      editorUserId: assignees.editorUserId,
    })
    .returning({ id: productionItems.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
