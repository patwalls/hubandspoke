import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { refreshItemMetrics } from "@/lib/services/performance-decay";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Manual per-item metrics refresh, used by the "Sync" button on the content
// detail page and the Retry button on /settings/sync-errors. Costs at most 1
// SC credit per invocation.
export async function POST(_request: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  try {
    const result = await refreshItemMetrics(id);
    return NextResponse.json({
      ok: true,
      ...result,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    // Mirror orchestrator behavior: stamp the item so a bad URL doesn't stay
    // unstamped forever, and the Sync Errors UI reflects the latest error.
    await db
      .update(productionItems)
      .set({
        lastPerformanceSyncAt: new Date(),
        lastPerformanceSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, id));
    return NextResponse.json({ ok: false, error: message }, { status: 200 });
  }
}
