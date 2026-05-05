import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { descriptPacks } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const [pack] = await db
    .select()
    .from(descriptPacks)
    .where(eq(descriptPacks.id, id))
    .limit(1);
  if (!pack) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }
  return NextResponse.json(pack);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    name?: string;
    prompt?: string;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  // Partial-patch semantics — match the formats PUT pattern so an autosave
  // UI can fire one-field updates per blur/keystroke without clobbering
  // the other column.
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) {
    const trimmed = body.name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    update.name = trimmed;
  }
  if (body.prompt !== undefined) {
    if (!body.prompt.trim()) {
      return NextResponse.json({ error: "prompt cannot be empty" }, { status: 400 });
    }
    update.prompt = body.prompt;
  }
  const [updated] = await db
    .update(descriptPacks)
    .set(update)
    .where(eq(descriptPacks.id, id))
    .returning();
  if (!updated) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }
  return NextResponse.json(updated);
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  // FK on formats.descript_pack_id is ON DELETE SET NULL — formats that
  // referenced this pack lose the attachment and the clip-triage UI re-
  // gates them. No cascade beyond that.
  const deleted = await db
    .delete(descriptPacks)
    .where(eq(descriptPacks.id, id))
    .returning({ id: descriptPacks.id });
  if (deleted.length === 0) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
