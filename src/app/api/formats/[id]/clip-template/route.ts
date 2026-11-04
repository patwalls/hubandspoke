import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature, requireBrandEdit } from "@/lib/auth-guards";
import { brandOfFormat } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { clipLookSchema } from "@/lib/clip-editor/doc";
import { resolveClipAspectRatio } from "@/lib/db/formats";
import { loadLookEdits } from "@/lib/services/clip-editor/look-edits";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The format's clip look (what new clip edits start from), if any, and
 *  what editors changed in the clips that started from it (`edits`, null
 *  when too few). */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db
    .select({ brand: formats.brand, name: formats.name, look: formats.clipTemplate, updatedAt: formats.clipTemplateUpdatedAt, clipAspectRatio: formats.clipAspectRatio, clipTargetPostType: formats.clipTargetPostType })
    .from(formats)
    .where(eq(formats.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  const look = row.look ? clipLookSchema.safeParse(row.look) : null;
  const edits =
    look?.success && row.updatedAt
      ? await loadLookEdits({ brand: row.brand, formatName: row.name, look: look.data, lookSavedAt: row.updatedAt }).catch((err) => (console.error("[clip-template] edits failed:", err), null))
      : null;
  return NextResponse.json({ look: row.look ?? null, updatedAt: row.updatedAt, aspectRatio: resolveClipAspectRatio(row), edits });
}

/** Save the look from the format page's look editor. Body: `{ look: ClipLook }`. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfFormat(id));
  if (brandGuard.response) return brandGuard.response;
  const body = (await request.json().catch(() => ({}))) as { look?: unknown };
  const parsed = clipLookSchema.safeParse(body.look);
  if (!parsed.success) return NextResponse.json({ error: "Invalid look" }, { status: 400 });
  const [row] = await db.update(formats).set({ clipTemplate: parsed.data, clipTemplateUpdatedAt: new Date() }).where(eq(formats.id, id)).returning({ updatedAt: formats.clipTemplateUpdatedAt });
  if (!row) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  return NextResponse.json({ ok: true, updatedAt: row.updatedAt });
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const brandGuard = await requireBrandEdit(await brandOfFormat(id));
  if (brandGuard.response) return brandGuard.response;
  await db.update(formats).set({ clipTemplate: null, clipTemplateUpdatedAt: null }).where(eq(formats.id, id));
  return NextResponse.json({ ok: true });
}
