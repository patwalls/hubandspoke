import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { clipIdeas } from "@/lib/db/schema";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    hook?: unknown;
  };

  const updates: { hook?: string } = {};
  if (typeof body.hook === "string") {
    const trimmed = body.hook.trim();
    if (!trimmed) {
      return NextResponse.json(
        { error: "Hook cannot be empty" },
        { status: 400 },
      );
    }
    if (trimmed.length > 500) {
      return NextResponse.json(
        { error: "Hook too long (max 500 chars)" },
        { status: 400 },
      );
    }
    updates.hook = trimmed;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No editable fields supplied" }, { status: 400 });
  }

  const [row] = await db
    .select({ status: clipIdeas.status })
    .from(clipIdeas)
    .where(eq(clipIdeas.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status === "killed") {
    return NextResponse.json(
      { error: "Cannot edit a killed idea" },
      { status: 409 },
    );
  }

  await db.update(clipIdeas).set(updates).where(eq(clipIdeas.id, id));
  return NextResponse.json({ ok: true, ...updates });
}
