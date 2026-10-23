import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getMyWork } from "@/lib/my-work/queries";
import { upNext } from "@/lib/my-work/split";

/**
 * GET /api/my-work/next?current=<itemId>
 *
 * The content page's "Up next" link: the next post waiting on you (to review
 * first, then your turn) other than the one you're on, and how many are
 * waiting besides it. Fetched when the page's status changes, never on a timer.
 */
export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ next: null, remaining: 0 });
  const current = req.nextUrl.searchParams.get("current");
  const { next, remaining } = upNext(await getMyWork(userId), current);
  return NextResponse.json({
    next: next && { id: next.id, title: next.title, brand: next.brand, status: next.status },
    remaining,
  });
}
