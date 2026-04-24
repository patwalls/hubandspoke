import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { enqueue } from "@/jobs/enqueue";
import { getAccountById } from "@/lib/db/accounts";
import {
  platformSupportsLatest,
  platformSupportsBackfill,
} from "@/lib/services/account-content-sync";

/**
 * Manually trigger a per-account content sync. Always async — the job goes
 * on graphile-worker and returns immediately. See
 * `src/lib/services/account-content-sync.ts` for the pull mechanics.
 *
 *   POST /api/accounts/[id]/sync-content              → latest (1 page)
 *   POST /api/accounts/[id]/sync-content?mode=backfill → up to 50 pages
 *   POST /api/accounts/[id]/sync-content?maxPages=20   → custom cap
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const account = await getAccountById(id);
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (!platformSupportsLatest(account.platform)) {
    return NextResponse.json(
      {
        error: `Scrape Creators has no content-list endpoint for platform=${account.platform}`,
      },
      { status: 400 }
    );
  }

  const modeParam = request.nextUrl.searchParams.get("mode");
  const mode: "latest" | "backfill" =
    modeParam === "backfill" ? "backfill" : "latest";
  if (mode === "backfill" && !platformSupportsBackfill(account.platform)) {
    return NextResponse.json(
      {
        error: `Backfill unsupported for ${account.platform}; this platform only exposes recent posts. Use mode=latest.`,
      },
      { status: 400 }
    );
  }

  const maxPagesParam = request.nextUrl.searchParams.get("maxPages");
  const maxPages = maxPagesParam
    ? Math.max(1, Math.min(100, parseInt(maxPagesParam, 10) || 0))
    : undefined;

  const jobKey = `account-content-sync-${id}-${mode}`;
  await enqueue(
    "account-content-sync",
    {
      accountId: id,
      mode,
      maxPages,
    },
    {
      jobKey,
      jobKeyMode: "unsafe_dedupe",
    }
  );

  return NextResponse.json({ queued: true, mode, maxPages, jobKey });
}
