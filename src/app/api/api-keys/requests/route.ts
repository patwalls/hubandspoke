import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { isAdminNow } from "@/lib/brand-access";
import { listRecentApiRequests } from "@/lib/api/keys";

/** GET /api/api-keys/requests — my recent API requests (`?all=1` → everyone's, admins only). */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const wantAll = request.nextUrl.searchParams.get("all") === "1";
  if (wantAll && !(await isAdminNow(guard.session))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);
  return NextResponse.json({
    requests: await listRecentApiRequests({ userId: guard.session.user.id, all: wantAll, limit }),
  });
}
