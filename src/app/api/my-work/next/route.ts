import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { getMyWork } from "@/lib/my-work/queries";
import { upNext } from "@/lib/my-work/split";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/my-work/next?current=<itemId>
 *
 * The content page's "Up next" link: the next post waiting on you (to review
 * first, then your turn) other than the one you're on, and how many are
 * waiting besides it, and whether the current post is still waiting on you
 * (when that flips, the page offers the next one). Siblings of the current
 * post (same post cross-posted, same video clipped) come first, and
 * `sameSource` says so. Fetched when the page's status or editor changes,
 * never on a timer.
 */
export async function GET(req: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;
  if (!userId) return NextResponse.json({ next: null, remaining: 0, currentWaiting: false });
  const raw = req.nextUrl.searchParams.get("current");
  const current = raw && UUID_RE.test(raw) ? raw : null;
  const [split, links] = await Promise.all([
    getMyWork(userId),
    current
      ? db
          .select({
            repostedFromItemId: productionItems.repostedFromItemId,
            pillarContentItemId: productionItems.pillarContentItemId,
          })
          .from(productionItems)
          .where(eq(productionItems.id, current))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null,
  ]);
  const { next, remaining, currentWaiting, sameSource } = upNext(split, current, links);
  return NextResponse.json({
    next: next && { id: next.id, title: next.title, brand: next.brand, status: next.status },
    remaining,
    currentWaiting,
    sameSource,
  });
}
