import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

// Marks one or more notifications as read. Accepts either { ids: string[] } to
// dismiss specific rows (e.g. clicking a bell entry) or { all: true } to clear
// the whole inbox. Always scopes the update to the session user so a malicious
// payload can't toggle someone else's state.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const session = guard.session;

  const body = await request.json().catch(() => ({}));
  const userId = session.user.id;
  const now = new Date();

  if (body?.all === true) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(eq(notifications.userId, userId), isNull(notifications.readAt))
      );
    return NextResponse.json({ ok: true });
  }

  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.filter((v: unknown): v is string => typeof v === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json(
      { error: "ids[] or all:true required" },
      { status: 400 },
    );
  }

  await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, ids),
        isNull(notifications.readAt),
      ),
    );

  return NextResponse.json({ ok: true });
}
