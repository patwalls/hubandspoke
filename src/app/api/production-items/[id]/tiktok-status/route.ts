import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { reconcileTikTokPublish } from "@/lib/services/tiktok-draft/send";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Poll target for a `publishing` TikTok item. Each call asks Zernio whether the
 * async publish has landed and, if so, flips the item to Published (+ live link
 * when TikTok returns one). The content page's publish banner hits this every
 * few seconds while a spinner shows, so the flip happens without depending on
 * the worker dyno or the Zernio webhook being configured.
 *
 * Returns `{ zernioStatus, publishedLink, status, settled }`. `settled` true =
 * stop polling (published or failed).
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;
  const { id } = await context.params;

  try {
    const result = await reconcileTikTokPublish(id, actorUserId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
