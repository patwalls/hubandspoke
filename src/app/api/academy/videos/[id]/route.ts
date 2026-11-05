import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories, academyVideos } from "@/lib/db/schema";
import { videoInputSchema } from "@/lib/academy/validate";
import { sanitizeGuideHtml } from "@/lib/academy/guide-html";
import { nextVideoSortOrder } from "@/lib/academy/mutations";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/academy/videos/[id] — Academy editor: edit a video. The slug (URL) never
 * changes, so links people have shared keep working after a rename. Moving
 * to another category puts the video at the end of that category.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const parsed = videoInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid video" }, { status: 400 });
  }
  // The step-by-step guide is editor HTML — keep only the tags GuideEditor makes.
  const input = { ...parsed.data, notes: parsed.data.notes ? sanitizeGuideHtml(parsed.data.notes) || null : null };

  const [existing] = await db.select().from(academyVideos).where(eq(academyVideos.id, id));
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [category] = await db
    .select({ id: academyCategories.id })
    .from(academyCategories)
    .where(eq(academyCategories.id, input.categoryId));
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 400 });

  const moved = existing.categoryId !== input.categoryId;
  const [video] = await db
    .update(academyVideos)
    .set({
      ...input,
      ...(moved ? { sortOrder: await nextVideoSortOrder(input.categoryId, id) } : {}),
      // Unticking "Coming soon" releases the video — it shows "New" from now.
      ...(existing.comingSoon && !input.comingSoon ? { availableAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(academyVideos.id, id))
    .returning({ id: academyVideos.id, slug: academyVideos.slug });

  return NextResponse.json({ video });
}

/** DELETE /api/academy/videos/[id] — Academy editor: remove a video (and everyone's progress on it). */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const deleted = await db.delete(academyVideos).where(eq(academyVideos.id, id)).returning({ id: academyVideos.id });
  if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
