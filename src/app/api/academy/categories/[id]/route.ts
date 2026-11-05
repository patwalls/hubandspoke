import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories, academyVideos } from "@/lib/db/schema";
import { categoryInputSchema } from "@/lib/academy/validate";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** PATCH /api/academy/categories/[id] — Academy editor: rename / re-describe a category. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const parsed = categoryInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid category" }, { status: 400 });
  }
  const updated = await db
    .update(academyCategories)
    .set(parsed.data)
    .where(eq(academyCategories.id, id))
    .returning({ id: academyCategories.id });
  if (updated.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** DELETE /api/academy/categories/[id] — Academy editor: only an empty category can be deleted. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [video] = await db
    .select({ id: academyVideos.id })
    .from(academyVideos)
    .where(eq(academyVideos.categoryId, id))
    .limit(1);
  if (video) {
    return NextResponse.json({ error: "Move or delete this category's videos first" }, { status: 409 });
  }
  const deleted = await db
    .delete(academyCategories)
    .where(eq(academyCategories.id, id))
    .returning({ id: academyCategories.id });
  if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
