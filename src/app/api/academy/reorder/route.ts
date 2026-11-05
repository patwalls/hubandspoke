import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories, academyVideos } from "@/lib/db/schema";
import { reorderSchema } from "@/lib/academy/validate";

/**
 * POST /api/academy/reorder — Academy editor.
 * Body: { kind: "videos" | "categories", ids, categoryId? }
 * Sets sort_order to each id's position in `ids`. For videos, pass one
 * category's full list in its new order; with `categoryId`, those videos are
 * also moved into that category (dragging a video across categories).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;

  const parsed = reorderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid reorder" }, { status: 400 });
  const { kind, ids, categoryId } = parsed.data;

  if (kind === "videos" && categoryId) {
    const [category] = await db.select({ id: academyCategories.id }).from(academyCategories).where(eq(academyCategories.id, categoryId));
    if (!category) return NextResponse.json({ error: "Category not found" }, { status: 400 });
  }

  await db.transaction(async (tx) => {
    await Promise.all(
      ids.map((id, index) =>
        kind === "videos"
          ? tx
              .update(academyVideos)
              .set({ sortOrder: index, ...(categoryId ? { categoryId } : {}) })
              .where(eq(academyVideos.id, id))
          : tx.update(academyCategories).set({ sortOrder: index }).where(eq(academyCategories.id, id)),
      ),
    );
  });
  return NextResponse.json({ ok: true });
}
