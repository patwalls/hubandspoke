import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getMyWork } from "@/lib/my-work/queries";
import { waitingCount } from "@/lib/my-work/split";

/**
 * GET /api/my-work/count
 *
 * The number on the header's My Work button: your turn (Assigned / Ready To
 * Publish on your items) + to review (Review items on brands you approve).
 * Fetched once per page load, never on a timer.
 */
export async function GET() {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ count: 0 });
  return NextResponse.json({ count: waitingCount(await getMyWork(userId)) });
}
