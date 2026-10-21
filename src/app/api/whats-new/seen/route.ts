import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// The signed-in user dismissed the What's new pop-up: stamp now so the cards
// they just saw don't pop up again (src/lib/whats-new → unseenFor). `upTo` is
// the newest card's shippedAt — a card stamped a little ahead of the clock
// would otherwise come straight back on the next load. Capped at a day ahead
// so a bad value can't silence future cards.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const now = Date.now();
  const upTo = typeof body?.upTo === "string" ? Date.parse(body.upTo) : NaN;
  const seenAt = Number.isFinite(upTo) && upTo > now ? Math.min(upTo, now + 86_400_000) : now;
  await db.update(users).set({ whatsNewSeenAt: new Date(seenAt) }).where(eq(users.id, userId));
  return NextResponse.json({ ok: true });
}
