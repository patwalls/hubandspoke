import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireFeature } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The format's clip look (what new clip edits start from), if any. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [row] = await db.select({ look: formats.clipTemplate, updatedAt: formats.clipTemplateUpdatedAt }).from(formats).where(eq(formats.id, id)).limit(1);
  if (!row) return NextResponse.json({ error: "Format not found" }, { status: 404 });
  return NextResponse.json({ look: row.look ?? null, updatedAt: row.updatedAt });
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireFeature("clipEditor");
  if (guard.response) return guard.response;
  const { id } = await context.params;
  await db.update(formats).set({ clipTemplate: null, clipTemplateUpdatedAt: null }).where(eq(formats.id, id));
  return NextResponse.json({ ok: true });
}
