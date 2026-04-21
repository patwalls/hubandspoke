import { NextRequest, NextResponse } from "next/server";
import { syncAllMATG, syncMATGYouTube } from "@/lib/services/matg-sync";
import { syncPerformanceData, getItemsDueForSync } from "@/lib/services/performance-decay";
import { db } from "@/lib/db";
import { syncLogs } from "@/lib/db/schema";
import { eq, desc, or } from "drizzle-orm";

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/sync/youtube
 *
 * Returns the last sync time and performance sync status.
 */
export async function GET() {
  try {
    // Last discovery sync
    const [lastSync] = await db
      .select()
      .from(syncLogs)
      .where(
        or(
          eq(syncLogs.syncType, "matg-all"),
          eq(syncLogs.syncType, "youtube-matg")
        )
      )
      .orderBy(desc(syncLogs.startedAt))
      .limit(1);

    // Last performance sync
    const [lastPerfSync] = await db
      .select()
      .from(syncLogs)
      .where(eq(syncLogs.syncType, "matg-performance"))
      .orderBy(desc(syncLogs.startedAt))
      .limit(1);

    // Items due for performance sync
    let dueSummary = null;
    try {
      dueSummary = await getItemsDueForSync();
    } catch {
      // Non-critical — dashboard still works without this
    }

    return NextResponse.json({
      lastSync: lastSync
        ? {
            syncType: lastSync.syncType,
            status: lastSync.status,
            startedAt: lastSync.startedAt,
            completedAt: lastSync.completedAt,
            itemsFetched: lastSync.itemsFetched,
            itemsCreated: lastSync.itemsCreated,
            itemsUpdated: lastSync.itemsUpdated,
          }
        : null,
      lastPerformanceSync: lastPerfSync
        ? {
            status: lastPerfSync.status,
            startedAt: lastPerfSync.startedAt,
            completedAt: lastPerfSync.completedAt,
            itemsUpdated: lastPerfSync.itemsUpdated,
          }
        : null,
      performanceDue: dueSummary
        ? {
            totalDue: dueSummary.totalDue,
            byTier: dueSummary.byTier,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json({ lastSync: null });
  }
}

/**
 * POST /api/sync/youtube
 *
 * Triggers sync for MATG content.
 *
 * Query params:
 *   ?mode=performance — decay-based performance update (cheaper, self-throttling)
 *   ?force=true       — bypass cooldown (full sync only)
 *   ?youtube-only=true — only sync YouTube videos (1 credit, legacy mode)
 *
 * Default (no mode): full discovery sync (2 credits, 1h cooldown)
 */
export async function POST(request: NextRequest) {
  try {
    const mode = request.nextUrl.searchParams.get("mode");

    // Performance mode — uses decay schedule, no cooldown needed
    if (mode === "performance") {
      const result = await syncPerformanceData();
      return NextResponse.json(result, { status: 200 });
    }

    // Full sync modes below — have cooldown
    const force = request.nextUrl.searchParams.get("force") === "true";
    const youtubeOnly = request.nextUrl.searchParams.get("youtube-only") === "true";

    // Check cooldown for full sync
    if (!force) {
      const [lastSync] = await db
        .select()
        .from(syncLogs)
        .where(
          or(
            eq(syncLogs.syncType, "matg-all"),
            eq(syncLogs.syncType, "youtube-matg")
          )
        )
        .orderBy(desc(syncLogs.startedAt))
        .limit(1);

      if (lastSync?.completedAt) {
        const elapsed = Date.now() - new Date(lastSync.completedAt).getTime();
        if (elapsed < COOLDOWN_MS) {
          const minutesLeft = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
          return NextResponse.json(
            {
              skipped: true,
              message: `Sync cooldown active. Next sync available in ${minutesLeft} min.`,
              lastSync: {
                completedAt: lastSync.completedAt,
                itemsFetched: lastSync.itemsFetched,
                itemsCreated: lastSync.itemsCreated,
                itemsUpdated: lastSync.itemsUpdated,
              },
            },
            { status: 200 }
          );
        }
      }
    }

    if (youtubeOnly) {
      const result = await syncMATGYouTube();
      return NextResponse.json(result, { status: 200 });
    }

    const result = await syncAllMATG();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("MATG sync failed:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
