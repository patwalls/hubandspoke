import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { accounts, productionItems } from "@/lib/db/schema";
import { resolveAssignees } from "@/lib/services/assignees";
import { normalizeFormatForWrite } from "@/lib/services/format-validation";
import { generateUtmCampaign } from "@/lib/utm-campaign";
import { isNotionAuthoritativeAccount } from "@/lib/platform";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/cross-post
 *
 * Body:
 *   { targetAccountId: string,
 *     targetPostType?: string | null,
 *     assign?: boolean,
 *     editorUserId?: string | null }
 *
 * Creates a new `cross_post` production item from the source item for the
 * given target account. Inherits title, thumbnail, format, pillar, and brand
 * from the source. Returns the new item id so the client can redirect to
 * the detail page.
 *
 * Status semantics:
 *   - default (no `assign`, no `editorUserId`) → status = "Idea". Used by
 *     the per-item Cross-post submenu on `/content/[id]`.
 *   - `assign: true` and/or `editorUserId` provided → status = "Assigned".
 *     `editorUserId` overrides `resolveAssignees`'s pick. Used by the v3
 *     cross-post queue modal so "Cross-post to @handle" creates an
 *     already-assigned item in a single round-trip.
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
  const editorUserIdRaw = (body as { editorUserId?: unknown }).editorUserId;
  const editorUserIdOverride =
    typeof editorUserIdRaw === "string" && editorUserIdRaw.trim().length > 0
      ? editorUserIdRaw.trim()
      : null;
  const assign = (body as { assign?: unknown }).assign === true;

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

  // Don't propagate a stale `format` from the source — if the source row
  // points at a format name that no longer exists in the brand's formats
  // table (legacy auto-default like "Tweet"), drop to null instead of
  // carrying the drift forward.
  const formatCheck = await normalizeFormatForWrite(source.brand, source.format);
  const inheritedFormat = formatCheck.ok ? formatCheck.value : null;

  const assignees = await resolveAssignees({
    brand: source.brand,
    sourceItemId: source.id,
    format: inheritedFormat,
  });

  const editorUserId = editorUserIdOverride ?? assignees.editorUserId;
  const status = assign || editorUserIdOverride ? "Assigned" : "Idea";

  const [created] = await db
    .insert(productionItems)
    .values({
      brand: source.brand,
      title: source.title,
      thumbnail: source.thumbnail,
      status,
      accountId: targetAccountId,
      postType: targetPostType,
      sourceType: "cross_post",
      repostedFromItemId: source.id,
      format: inheritedFormat,
      pillarContentNotionId: source.pillarContentNotionId,
      pillarContentItemId: source.pillarContentItemId,
      utmCampaign: await generateUtmCampaign(source.title),
      producerUserId: assignees.producerUserId,
      editorUserId,
    })
    .returning({ id: productionItems.id });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
