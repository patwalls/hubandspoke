import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import {
  recordContentChanges,
  type ContentChange,
} from "@/lib/services/content-revisions";

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
  const knownKeys = new Set(schema.fields.map((f) => f.key));
  const keyToType = new Map(schema.fields.map((f) => [f.key, f.type] as const));

  const patchRecord = patch as Record<string, unknown>;
  const prevContent = draft.content as ContentDraftContent;
  const nextContent: ContentDraftContent = { ...prevContent };

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
        nextContent[key] = value;
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
        nextContent[key] = (value as string[]).map((v) => v.trim()).filter(Boolean);
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

  // Clone-on-write: demote current, insert v+1. Both writes inside the
  // same tx as the diff emission so the version chain + audit trail
  // commit atomically. The partial unique index
  // `uq_content_drafts_current` enforces single-current at the DB level
  // — order matters (demote before insert) to avoid a transient
  // violation.
  const [inserted] = await db.transaction(async (tx) => {
    await tx
      .update(contentDrafts)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(eq(contentDrafts.id, draft.id));

    const [next] = await tx
      .insert(contentDrafts)
      .values({
        productionItemId: id,
        version: draft.version + 1,
        isCurrent: true,
        content: nextContent,
        fieldSchemaSnapshot: draft.fieldSchemaSnapshot as FormatFieldSchema,
        generatedBy: "user:edit",
        promptVersion: draft.promptVersion,
        modelUsage: null,
        createdByUserId: actorUserId,
      })
      .returning();

    // One `content_changed` event per field touched in the patch whose
    // value actually moved. recordContentChanges drops no-ops so if
    // someone re-saves the same text the activity feed stays quiet.
    const changes: ContentChange[] = [];
    for (const key of Object.keys(patchRecord)) {
      const prev = prevContent[key];
      const post = nextContent[key];
      changes.push({
        target: {
          kind: "draft_field",
          draftId: next.id,
          version: next.version,
          field: key,
        },
        from: coerce(prev),
        to: coerce(post),
      });
    }
    await recordContentChanges({
      tx,
      contentItemId: id,
      userId: actorUserId,
      source: { kind: "user" },
      changes,
    });

    return [next];
  });

  return NextResponse.json({ draft: inserted });
}

/**
 * Coerce a content-draft field value to the primitive shape the event
 * payload expects. Tags become a comma-joined string so the diff renders
 * compactly; slides intentionally pass through as null (we don't ship
 * slide editing yet and the renderer can't sensibly diff an array of
 * objects in the activity feed).
 */
function coerce(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (Array.isArray(v)) {
    const parts = v
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    return parts.join(", ");
  }
  return null;
}
