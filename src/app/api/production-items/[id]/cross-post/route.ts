import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { isNotionAuthoritativeAccount } from "@/lib/platform";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/cross-post
 *
 * Body: { targetAccountId: string, targetPostType?: string | null }
 *
 * Creates a new `cross_post` production item from the source item for the
 * given target account. Inherits title, thumbnail, format, pillar, and brand
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

  const targetAccountId =
    typeof (body as { targetAccountId?: unknown }).targetAccountId === "string"
      ? (body as { targetAccountId: string }).targetAccountId.trim()
      : "";
  const targetPostTypeRaw = (body as { targetPostType?: unknown }).targetPostType;
  const targetPostType =
    typeof targetPostTypeRaw === "string" && targetPostTypeRaw.trim().length > 0
      ? targetPostTypeRaw.trim()
      : null;

  if (!targetAccountId) {
    return NextResponse.json(
      { error: "targetAccountId is required" },
      { status: 400 }
    );
  }

  const [target] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, targetAccountId))
    .limit(1);

  if (!target) {
    return NextResponse.json({ error: "Target account not found" }, { status: 404 });
  }

  if (isNotionAuthoritativeAccount(target)) {
    return NextResponse.json(
      {
        error:
          "Target account is Notion-authoritative; create that post in Notion instead.",
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

  if (source.accountId === targetAccountId && source.postType === targetPostType) {
    return NextResponse.json(
      { error: "Source is already on the target account" },
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
        eq(productionItems.accountId, targetAccountId)
      )
    )
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: "A cross-post for this target account already exists", existingId: existing.id },
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
      accountId: targetAccountId,
      postType: targetPostType,
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
