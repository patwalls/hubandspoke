import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

/**
 * GET /api/reports/matg
 *
 * Returns MATG production items (YouTube videos) sorted by published date.
 */
export async function GET() {
  try {
    const items = await db
      .select()
      .from(productionItems)
      .where(eq(productionItems.brand, "matg"))
      .orderBy(desc(productionItems.publishedDate));

    // Compute aggregate stats
    const totalViews = items.reduce((sum, item) => sum + (item.views || 0), 0);
    const totalVideos = items.length;
    const avgViews = totalVideos > 0 ? Math.round(totalViews / totalVideos) : 0;

    return NextResponse.json({
      items,
      stats: {
        totalVideos,
        totalViews,
        avgViews,
      },
    });
  } catch (error) {
    console.error("Error fetching MATG report:", error);
    return NextResponse.json(
      { error: "Failed to fetch MATG report" },
      { status: 500 }
    );
  }
}
