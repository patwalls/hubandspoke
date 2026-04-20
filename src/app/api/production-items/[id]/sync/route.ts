import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { refreshItemMetrics } from "@/lib/services/performance-decay";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Manual per-item metrics refresh, used by the "Sync" button on the content
// detail page. Costs at most 1 SC credit per invocation.
export async function POST(_request: NextRequest, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const result = await refreshItemMetrics(id);

    return NextResponse.json({
      ok: true,
      ...result,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error syncing item metrics:", error);
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
