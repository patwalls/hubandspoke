import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { and, eq, isNotNull, desc } from "drizzle-orm";

/**
 * GET /api/formats/top-performers?brand=starter-story
 *
 * Returns top 3 posts by views for each format name.
 * Response: { [formatName]: [{ title, views, publishedLink, publishedDate }] }
 */
export async function GET(request: NextRequest) {
  try {
    const brand =
      request.nextUrl.searchParams.get("brand") || "starter-story";

    const items = await db
      .select({
        title: productionItems.title,
        format: productionItems.format,
        views: productionItems.views,
        publishedLink: productionItems.publishedLink,
        publishedDate: productionItems.publishedDate,
        thumbnail: productionItems.thumbnail,
      })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, brand),
          eq(productionItems.status, "Published"),
          isNotNull(productionItems.format),
          isNotNull(productionItems.views)
        )
      )
      .orderBy(desc(productionItems.views));

    // Group by format, keep top 3 per format
    const byFormat: Record<
      string,
      { title: string | null; views: number; publishedLink: string | null; publishedDate: string | null; thumbnail: string | null }[]
    > = {};

    for (const item of items) {
      const key = item.format!;
      if (!byFormat[key]) byFormat[key] = [];
      if (byFormat[key].length < 3) {
        byFormat[key].push({
          title: item.title,
          views: item.views!,
          publishedLink: item.publishedLink,
          publishedDate: item.publishedDate,
          thumbnail: item.thumbnail,
        });
      }
    }

    return NextResponse.json(byFormat);
  } catch (error) {
    console.error("Error fetching top performers:", error);
    return NextResponse.json(
      { error: "Failed to fetch top performers" },
      { status: 500 }
    );
  }
}
