import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { notifications } from "@/lib/db/schema";
import { parseMarkReadBody } from "@/lib/notifications/unread";

// Marks notifications as read. Accepts { ids: string[] } to dismiss specific
// rows (clicking a bell entry), { contentItemId } to clear everything about one
// post (opening the post — see src/lib/notifications/unread.ts), or
// { all: true } to clear the whole inbox. Always scopes the update to the
// session user so a malicious payload can't toggle someone else's state.
// Returns { ok, updated } — the post page only pokes the bell when updated > 0.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const session = guard.session;

  const parsed = parseMarkReadBody(await request.json().catch(() => ({})));
  if (!parsed) {
    return NextResponse.json(
      { error: "ids[], contentItemId or all:true required" },
      { status: 400 },
    );
  }

  const mine = and(
    eq(notifications.userId, session.user.id),
    isNull(notifications.readAt),
  );
  const where =
    parsed.kind === "all"
      ? mine
      : parsed.kind === "item"
        ? and(mine, eq(notifications.contentItemId, parsed.contentItemId))
        : and(mine, inArray(notifications.id, parsed.ids));

  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(where)
    .returning({ id: notifications.id });

  return NextResponse.json({ ok: true, updated: updated.length });
}
