import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { clipLookSchema } from "@/lib/clip-editor/doc";
import { resolveClipAspectRatio } from "@/lib/db/formats";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The format's clip look (what new clip edits start from), if any. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db
    .select({ look: formats.clipTemplate, updatedAt: formats.clipTemplateUpdatedAt, clipAspectRatio: formats.clipAspectRatio, clipTargetPostType: formats.clipTargetPostType })
    .from(formats)
    .where(eq(formats.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  return NextResponse.json({ look: row.look ?? null, updatedAt: row.updatedAt, aspectRatio: resolveClipAspectRatio(row) });
}

/** Save the look from the format page's look editor. Body: `{ look: ClipLook }`. */
export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
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
  await db.update(formats).set({ clipTemplate: null, clipTemplateUpdatedAt: null }).where(eq(formats.id, id));
  return NextResponse.json({ ok: true });
}
