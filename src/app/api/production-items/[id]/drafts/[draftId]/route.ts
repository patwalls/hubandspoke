import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  contentDrafts,
  type ContentDraftContent,
  type FormatFieldSchema,
} from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string; draftId: string }>;
}

// PUT /api/production-items/[id]/drafts/[draftId]
// Mutates the current draft in place. Stage 1 supports per-field patches:
//   { patch: { <fieldKey>: <value> } }
// The new value is validated against fieldSchemaSnapshot (types only — per-
// field constraints like maxLength are UI-enforced for now).
// Only the current draft is editable. History rows are immutable.
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

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
  const nextContent: ContentDraftContent = {
    ...(draft.content as ContentDraftContent),
  };

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

  const [updated] = await db
    .update(contentDrafts)
    .set({ content: nextContent, updatedAt: new Date() })
    .where(eq(contentDrafts.id, draftId))
    .returning();

  return NextResponse.json({ draft: updated });
}
