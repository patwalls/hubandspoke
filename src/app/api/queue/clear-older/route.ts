import { NextRequest, NextResponse } from "next/server";
import { requireBrandEdit, requireFeature } from "@/lib/auth-guards";
import { invalidateReportCaches } from "@/lib/invalidate-report-caches";
import { parseClearOlderRequest } from "@/lib/queue-clear-older";
import { countOlderIdeas, killOlderIdeas } from "@/lib/queue-clear-older.server";

export const dynamic = "force-dynamic";

/**
 * POST /api/queue/clear-older — the queue's "Kill all older ideas"
 * (flag `queueClearOlder`). Body: { brand, format?, dryRun?, reason? }.
 *   dryRun: true → { count } (what the confirm dialog shows)
 *   else         → { killed } after killing every Idea row of the brand
 *                  (and format) created more than 30 days ago.
 * See src/lib/queue-clear-older.ts.
 */
export async function POST(request: NextRequest) {
  const flag = await requireFeature("queueClearOlder");
  if (flag.response) return flag.response;

  const body = await request.json().catch(() => null);
  const parsed = parseClearOlderRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { brand, format, dryRun, reason } = parsed.value;

  const guard = await requireBrandEdit(brand);
  if (guard.response) return guard.response;

  if (dryRun) {
    return NextResponse.json({ count: await countOlderIdeas(brand, format) });
  }

  const killed = await killOlderIdeas({
    brand,
    format,
    reason: reason!,
    actorUserId: guard.session.user.id ?? null,
  });
  if (killed > 0) invalidateReportCaches({ brands: [brand] });
  return NextResponse.json({ killed });
}
