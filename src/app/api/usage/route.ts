import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { usageEvents } from "@/lib/db/schema";
import { isValidMark, screenFor } from "@/lib/usage/screen";

// Records one usage event for the signed-in user. Two shapes:
//   { path, search }  — a route view (UsageTracker); normalized server-side
//                       by screenFor so a client can't store raw ids.
//   { mark }          — a trackUsage() action like `modal:clip-editor`.
// Fire-and-forget from the client: always 204 on a well-formed request.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id ?? null;

  const body = await request.json().catch(() => ({}));
  let row: { kind: "view" | "action"; screen: string; brand: string | null };
  if (typeof body?.path === "string" && body.path.startsWith("/") && body.path.length < 500) {
    const s = screenFor(body.path, typeof body.search === "string" ? body.search.slice(0, 500) : "");
    row = { kind: "view", ...s };
  } else if (typeof body?.mark === "string" && isValidMark(body.mark)) {
    const brand = typeof body.brand === "string" && /^[a-z0-9-]{1,40}$/.test(body.brand) ? body.brand : null;
    row = { kind: "action", screen: body.mark, brand };
  } else {
    return NextResponse.json({ error: "path or mark required" }, { status: 400 });
  }

  await db.insert(usageEvents).values({ userId, ...row });
  return new NextResponse(null, { status: 204 });
}
