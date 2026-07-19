import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  productionItems,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import {
  applyDraftPatch,
  NoCurrentDraftError,
} from "@/lib/services/content-drafts/apply-patch";
import {
  getSchemaForPostType,
  type PostType,
} from "@/lib/platform-field-schemas";

interface RouteContext {
  params: Promise<{ id: string; draftId: string }>;
}

/**
 * PUT /api/production-items/[id]/drafts/[draftId]
 *
 * Mutates the current draft. Stage 1 accepts per-field patches:
 *
 *   { patch: { <fieldKey>: <value> } }
 *
 * Clone-on-write: instead of an in-place UPDATE that throws away the
 * prior content, we demote the current draft to isCurrent=false and
 * insert a NEW draft row with `version + 1` carrying the merged content.
 * The full version chain is the audit trail for caption text — the
 * activity feed renders one `content_changed` event per field that
 * moved, and the activity-feed expander can fetch any historical
 * version via `GET .../drafts?version=N`.
 *
 * Only the current draft is editable. Patching a stale snapshot would
 * silently bifurcate the version chain, so we reject it.
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id as string;

  const { id, draftId } = await context.params;

  const body = await request.json().catch(() => null);
  const patch =
    body && typeof body === "object" && body !== null
      ? (body as { patch?: unknown }).patch
      : undefined;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return NextResponse.json(
      { error: "Body must be { patch: { <fieldKey>: <value>, ... } }" },
      { status: 400 },
    );
  }

  const [draft] = await db
    .select()
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.id, draftId),
        eq(contentDrafts.productionItemId, id),
      ),
    )
    .limit(1);

  if (!draft) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }

  if (!draft.isCurrent) {
    return NextResponse.json(
      { error: "Only the current draft is editable. Generate a new version to revise a snapshot." },
      { status: 400 },
    );
  }

  const schema = draft.fieldSchemaSnapshot as FormatFieldSchema;
  // Forward-compat: a draft created before a new field was added to the
  // platform schema (e.g. Threads got a `cta` slot 2026-05-15) has a
  // snapshot that doesn't list the new key, but PLATFORM_FIELD_SCHEMAS
  // does. Allow PATCHing such keys — they're real and intentional, not
  // typos. Look up the live schema by the parent item's postType and
  // union its fields with the snapshot's.
  const [parentItem] = await db
    .select({ postType: productionItems.postType })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  const liveSchema = parentItem?.postType
    ? getSchemaForPostType(parentItem.postType as PostType) ?? null
    : null;
  const allFields = [
    ...schema.fields,
    ...(liveSchema?.fields ?? []).filter(
      (f) => !schema.fields.some((sf) => sf.key === f.key),
    ),
  ];
  const knownKeys = new Set(allFields.map((f) => f.key));
  const keyToType = new Map(allFields.map((f) => [f.key, f.type] as const));

  const patchRecord = patch as Record<string, unknown>;
  // Validate + normalize each patched field up front. The merge into the live
  // draft content happens inside the transaction below (against whatever is
  // current at lock time), so we only collect the validated values here.
  const validatedPatch: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(patchRecord)) {
    if (!knownKeys.has(key)) {
      return NextResponse.json(
        { error: `Unknown field "${key}" for this draft.` },
        { status: 400 },
      );
    }
    const fieldType = keyToType.get(key);
    switch (fieldType) {
      case "text":
      case "longtext":
        if (typeof value !== "string") {
          return NextResponse.json(
            { error: `Field "${key}" expects a string.` },
            { status: 400 },
          );
        }
        validatedPatch[key] = value;
        break;
      case "tags":
        if (
          !Array.isArray(value) ||
          value.some((v) => typeof v !== "string")
        ) {
          return NextResponse.json(
            { error: `Field "${key}" expects an array of strings.` },
            { status: 400 },
          );
        }
        validatedPatch[key] = (value as string[]).map((v) => v.trim()).filter(Boolean);
        break;
      case "slides":
        // Stage 1 does not ship slide editing — reject writes to slide
        // fields so we don't corrupt shape by accident.
        return NextResponse.json(
          { error: "Slide editing ships in Stage 2." },
          { status: 501 },
        );
    }
  }

  // Clone-on-write, serialized per item so concurrent autosaves chain instead
  // of colliding on `uq_content_drafts_current`. See applyDraftPatch.
  let inserted: Awaited<ReturnType<typeof applyDraftPatch>>;
  try {
    inserted = await applyDraftPatch({
      itemId: id,
      validatedPatch,
      actorUserId,
    });
  } catch (err) {
    if (err instanceof NoCurrentDraftError) {
      return NextResponse.json(
        {
          error:
            "The draft chain changed underneath this edit — reload and retry.",
        },
        { status: 409 },
      );
    }
    throw err;
  }

  return NextResponse.json({ draft: inserted });
}
