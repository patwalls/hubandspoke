import { NextRequest, NextResponse } from "next/server";
import { syncMATGYouTube } from "@/lib/services/youtube-sync";
import { db } from "@/lib/db";
import { syncLogs } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * GET /api/sync/youtube
 *
 * Returns the last sync time for the YouTube sync.
 */
export async function GET() {
  try {
    const [lastSync] = await db
      .select()
      .from(syncLogs)
      .where(eq(syncLogs.syncType, "youtube-matg"))
      .orderBy(desc(syncLogs.startedAt))
      .limit(1);

    return NextResponse.json({
      lastSync: lastSync
        ? {
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
 * Triggers a YouTube sync for the MATG channel.
 * Has a 1-hour cooldown to prevent excessive API usage.
 * Pass ?force=true to bypass cooldown.
 */
export async function POST(request: NextRequest) {
  try {
    const force = request.nextUrl.searchParams.get("force") === "true";

    // Check cooldown
    if (!force) {
      const [lastSync] = await db
        .select()
        .from(syncLogs)
        .where(eq(syncLogs.syncType, "youtube-matg"))
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

    const result = await syncMATGYouTube();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("YouTube sync failed:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
