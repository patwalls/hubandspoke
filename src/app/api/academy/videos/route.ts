import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories, academyVideos } from "@/lib/db/schema";
import { videoInputSchema } from "@/lib/academy/validate";
import { sanitizeGuideHtml } from "@/lib/academy/guide-html";
import { nextVideoSortOrder, uniqueVideoSlug } from "@/lib/academy/mutations";

/** POST /api/academy/videos — Academy editor: add a video to the Academy. */
export async function POST(request: NextRequest) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;

  const parsed = videoInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid video" }, { status: 400 });
  }
  // The step-by-step guide is editor HTML — keep only the tags GuideEditor makes.
  const input = { ...parsed.data, notes: parsed.data.notes ? sanitizeGuideHtml(parsed.data.notes) || null : null };

  const [category] = await db
    .select({ id: academyCategories.id })
    .from(academyCategories)
    .where(eq(academyCategories.id, input.categoryId));
  if (!category) return NextResponse.json({ error: "Category not found" }, { status: 400 });

  const [video] = await db
    .insert(academyVideos)
    .values({
      ...input,
      slug: await uniqueVideoSlug(input.title),
      sortOrder: await nextVideoSortOrder(input.categoryId),
      // "New" starts counting once it's watchable.
      availableAt: input.comingSoon ? null : new Date(),
    })
    .returning({ id: academyVideos.id, slug: academyVideos.slug });

  return NextResponse.json({ video });
}
