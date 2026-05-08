import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, productionItems } from "@/lib/db/schema";
import {
  PLATFORM_FIELD_SCHEMAS,
  type PostType,
} from "@/lib/platform-field-schemas";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/production-items/[id]/drafts/ensure
 *
 * Idempotently creates a v1 empty `contentDrafts` row for this item if
 * none exists yet, so the inline drafting simulator (X, IG, LinkedIn,
 * TikTok, …) flips from read-only to editable.
 *
 * Why this exists: the simulator is gated on `editable={draftId !== null}`,
 * and a draft row only gets created today by `repost-seed.ts` (on
 * repost / cross-post creation) and `generate-instagram-caption.ts` (IG
 * auto-fire). Items reached via any other path — manual creation, Notion
 * sync, clip-promotion-without-AI-caption — show "Read-only — no draft
 * yet" with no way to start typing. This endpoint closes the gap.
 *
 * Idempotent on retry: if a current draft already exists for the item the
 * route returns it without inserting a new row.
 *
 * Returns: `{ draftId: string, created: boolean }`.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const session = guard.session;

  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      postType: productionItems.postType,
    })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);

  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const postType = item.postType as PostType | null;
  if (!postType || !(postType in PLATFORM_FIELD_SCHEMAS)) {
    return NextResponse.json(
      { error: "Item has no recognised postType — can't pick a schema." },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select({ id: contentDrafts.id })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, id),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);

  if (existing) {
    return NextResponse.json({ draftId: existing.id, created: false });
  }

  const fieldSchema = PLATFORM_FIELD_SCHEMAS[postType];
  const [inserted] = await db
    .insert(contentDrafts)
    .values({
      productionItemId: id,
      version: 1,
      isCurrent: true,
      content: {},
      fieldSchemaSnapshot: fieldSchema,
      generatedBy: "empty",
      createdByUserId: session.user.id,
    })
    .returning({ id: contentDrafts.id });

  return NextResponse.json({ draftId: inserted.id, created: true });
}
