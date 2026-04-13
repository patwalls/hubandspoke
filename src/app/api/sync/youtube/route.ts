import { NextResponse } from "next/server";
import { syncMATGYouTube } from "@/lib/services/youtube-sync";

/**
 * POST /api/sync/youtube
 *
 * Triggers a YouTube sync for the MATG channel.
 * Pulls latest videos from Scrape Creators API and upserts into production_items.
 */
export async function POST() {
  try {
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
