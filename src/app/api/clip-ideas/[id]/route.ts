import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  accounts,
  clipIdeas,
  productionItems,
  users,
} from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;

  // Join twice on production_items:
  //   - `pillar` = the pillar this clip was derived from (via
  //     clipIdeas.sourceProductionItemId)
  //   - `sibling` = the queue-side production_item created at generation
  //     time (via productionItems.sourceClipIdeaId === clipIdeas.id)
  // The sibling carries the target post_type + accountId — both are needed
  // to render the per-format preview in the triage dialog (e.g. an X-post
  // simulator for X Quotables ideas).
  const sibling = alias(productionItems, "sibling");
  const [row] = await db
    .select({
      id: clipIdeas.id,
      hook: clipIdeas.hook,
      angle: clipIdeas.angle,
      rationale: clipIdeas.rationale,
      startSec: clipIdeas.startSec,
      endSec: clipIdeas.endSec,
      estimatedViews: clipIdeas.estimatedViews,
      status: clipIdeas.status,
      targetFormat: clipIdeas.targetFormat,
      extras: clipIdeas.extras,
      acceptedProductionItemId: clipIdeas.acceptedProductionItemId,
      sourceProductionItemId: clipIdeas.sourceProductionItemId,
      sourceBrand: productionItems.brand,
      siblingPostType: sibling.postType,
      siblingAccountHandle: accounts.handle,
      siblingAccountDisplayName: accounts.displayName,
      siblingAccountAvatarUrl: accounts.avatarUrl,
      siblingAccountPlatform: accounts.platform,
      siblingAccountVerified: accounts.verified,
      editorName: users.name,
      editorEmail: users.email,
    })
    .from(clipIdeas)
    .leftJoin(
      productionItems,
      eq(productionItems.id, clipIdeas.sourceProductionItemId),
    )
    .leftJoin(sibling, eq(sibling.sourceClipIdeaId, clipIdeas.id))
    .leftJoin(accounts, eq(accounts.id, sibling.accountId))
    .leftJoin(users, eq(users.id, clipIdeas.acceptedEditorUserId))
    .where(eq(clipIdeas.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    hook: row.hook,
    angle: row.angle,
    rationale: row.rationale,
    startSec: Number(row.startSec),
    endSec: Number(row.endSec),
    estimatedViews: row.estimatedViews,
    status: row.status,
    targetFormat: row.targetFormat,
    extras: row.extras,
    acceptedEditorName: row.editorName ?? row.editorEmail ?? null,
    acceptedProductionItemId: row.acceptedProductionItemId,
    sourceProductionItemId: row.sourceProductionItemId,
    sourceBrand: row.sourceBrand,
    targetPostType: row.siblingPostType,
    targetAccount: row.siblingAccountHandle
      ? {
          handle: row.siblingAccountHandle,
          displayName: row.siblingAccountDisplayName,
          avatarUrl: row.siblingAccountAvatarUrl,
          platform: row.siblingAccountPlatform,
          verified: row.siblingAccountVerified,
        }
      : null,
  });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    hook?: unknown;
  };

  const updates: { hook?: string } = {};
  if (typeof body.hook === "string") {
    const trimmed = body.hook.trim();
    if (!trimmed) {
      return NextResponse.json(
        { error: "Hook cannot be empty" },
        { status: 400 },
      );
    }
    if (trimmed.length > 500) {
      return NextResponse.json(
        { error: "Hook too long (max 500 chars)" },
        { status: 400 },
      );
    }
    updates.hook = trimmed;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const [row] = await db
    .select({
      status: clipIdeas.status,
      acceptedProductionItemId: clipIdeas.acceptedProductionItemId,
    })
    .from(clipIdeas)
    .where(eq(clipIdeas.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status === "killed") {
    return NextResponse.json(
      { error: "Cannot edit a killed idea" },
      { status: 409 },
    );
  }

  await db.update(clipIdeas).set(updates).where(eq(clipIdeas.id, id));

  // Mirror the hook edit onto the linked production_item so the queue row's
  // title and the prod_item.hook stay in sync. The prod_item is the queue-side
  // representation of an unaccepted clip idea — the title shown is the hook.
  if (updates.hook && row.acceptedProductionItemId) {
    await db
      .update(productionItems)
      .set({
        hook: updates.hook,
        title: updates.hook,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, row.acceptedProductionItemId));
  }

  return NextResponse.json({ ok: true, ...updates });
}
