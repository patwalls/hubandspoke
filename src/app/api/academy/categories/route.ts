import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requireAcademyEditor } from "@/lib/academy/editor-guard";
import { db } from "@/lib/db";
import { academyCategories } from "@/lib/db/schema";
import { categoryInputSchema } from "@/lib/academy/validate";

/** POST /api/academy/categories — Academy editor: add a category (goes at the end). */
export async function POST(request: NextRequest) {
  const guard = await requireAcademyEditor();
  if (guard.response) return guard.response;

  const parsed = categoryInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid category" }, { status: 400 });
  }

  const [row] = await db
    .select({ max: sql<number | null>`max(${academyCategories.sortOrder})` })
    .from(academyCategories);
  const [category] = await db
    .insert(academyCategories)
    .values({ ...parsed.data, sortOrder: (row?.max ?? -1) + 1 })
    .returning({ id: academyCategories.id, name: academyCategories.name });

  return NextResponse.json({ category });
}
