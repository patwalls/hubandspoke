import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories, academyVideos } from "@/lib/db/schema";
import { reorderSchema } from "@/lib/academy/validate";

/**
 * POST /api/academy/reorder — Academy editor. Body: { kind: "videos" | "categories", ids }
 * Sets sort_order to each id's position in `ids` (videos: pass one
 * category's videos in their new order).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;

  const parsed = reorderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid reorder" }, { status: 400 });
  const { kind, ids } = parsed.data;
  const table = kind === "videos" ? academyVideos : academyCategories;

  await db.transaction(async (tx) => {
    await Promise.all(ids.map((id, index) => tx.update(table).set({ sortOrder: index }).where(eq(table.id, id))));
  });
  return NextResponse.json({ ok: true });
}
