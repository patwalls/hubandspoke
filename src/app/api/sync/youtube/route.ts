import { NextRequest, NextResponse } from "next/server";
import { syncAllMATG, syncMATGYouTube } from "@/lib/services/matg-sync";
import { db } from "@/lib/db";
import { syncLogs } from "@/lib/db/schema";
import { eq, desc, or } from "drizzle-orm";

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/sync/youtube
 *
 * Returns the last sync time (checks both legacy youtube-matg and new matg-all).
 */
export async function GET() {
  try {
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
    });
  } catch (error) {
    return NextResponse.json({ lastSync: null });
  }
}

/**
 * POST /api/sync/youtube
 *
 * Triggers a multi-platform sync for MATG (YouTube + Shorts + Instagram + Twitter).
 * Uses ~4 API credits per sync. Has a 1-hour cooldown.
 *
 * Query params:
 *   ?force=true   — bypass cooldown
 *   ?youtube-only=true — only sync YouTube videos (1 credit, legacy mode)
 */
export async function POST(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get("force") === "true";
    const youtubeOnly = request.nextUrl.searchParams.get("youtube-only") === "true";

    // Check cooldown
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
