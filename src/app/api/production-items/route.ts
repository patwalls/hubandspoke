import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/production-items
 *
 * Manually create a production item (for platforms the API can't pull from).
 * If the published link is a YouTube URL, auto-fetches metrics.
 *
 * Body: {
 *   title: string
 *   platform: string[]
 *   format?: string
 *   publishedLink?: string
 *   publishedDate: string (YYYY-MM-DD)
 *   brand: string
 *   views?: number
 *   likes?: number
 *   comments?: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      title,
      platform,
      format,
      publishedLink,
      publishedDate,
      brand,
      views,
      likes,
      comments,
    } = body;

    if (!title || !platform?.length || !publishedDate || !brand) {
      return NextResponse.json(
        { error: "title, platform, publishedDate, and brand are required" },
        { status: 400 }
      );
    }

    let finalViews = views ?? null;
    let finalLikes = likes ?? null;
    let finalComments = comments ?? null;
    let thumbnail: string | null = null;
    let youtubeId: string | null = null;
    let youtubeUrl: string | null = null;
    let autoFetched = false;

    // Auto-fetch metrics for YouTube URLs
    const isYouTube =
      publishedLink &&
      (publishedLink.includes("youtube.com") ||
        publishedLink.includes("youtu.be"));

    if (isYouTube) {
      try {
        const { fetchSingleVideo } = await import(
          "@/lib/services/matg-sync"
        );
        const video = await fetchSingleVideo(publishedLink);
        finalViews = video.viewCountInt;
        finalLikes = video.likeCountInt;
        finalComments = video.commentCountInt;
        thumbnail = video.thumbnail || null;
        youtubeId = video.id;
        youtubeUrl = video.url;
        autoFetched = true;
      } catch (err) {
        console.warn("Auto-fetch failed for YouTube URL, using manual values:", err);
      }
    }

    const [created] = await db
      .insert(productionItems)
      .values({
        title,
        platform,
        format: format || null,
        publishedLink: publishedLink || null,
        publishedDate,
        brand,
        status: "Published",
        views: finalViews,
        likes: finalLikes,
        comments: finalComments,
        thumbnail,
        youtubeId,
        youtubeUrl,
        isExternal: false,
        lastPerformanceSyncAt: autoFetched ? new Date() : null,
      })
      .returning();

    return NextResponse.json({ ...created, autoFetched }, { status: 201 });
  } catch (error) {
    console.error("Error creating production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/production-items
 *
 * Update an existing production item.
 * Body: { id: string, ...fields to update }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      id,
      title,
      platform,
      format,
      publishedLink,
      publishedDate,
      views,
      likes,
      comments,
      clicks,
      leads,
      salesAmount,
    } = body;

    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (title !== undefined) updateData.title = title;
    if (platform !== undefined) updateData.platform = platform;
    if (format !== undefined) updateData.format = format || null;
    if (publishedLink !== undefined) updateData.publishedLink = publishedLink || null;
    if (publishedDate !== undefined) updateData.publishedDate = publishedDate;
    if (views !== undefined) updateData.views = views === "" || views === null ? null : Number(views);
    if (likes !== undefined) updateData.likes = likes === "" || likes === null ? null : Number(likes);
    if (comments !== undefined) updateData.comments = comments === "" || comments === null ? null : Number(comments);
    if (clicks !== undefined) updateData.clicks = clicks === "" || clicks === null ? null : Number(clicks);
    if (leads !== undefined) updateData.leads = leads === "" || leads === null ? null : Number(leads);
    if (salesAmount !== undefined) updateData.salesAmount = salesAmount === "" || salesAmount === null ? null : String(salesAmount);

    const [updated] = await db
      .update(productionItems)
      .set(updateData)
      .where(eq(productionItems.id, id))
      .returning();

    if (!updated) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/production-items
 *
 * Delete a production item by id.
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json(
        { error: "id is required" },
        { status: 400 }
      );
    }

    await db
      .delete(productionItems)
      .where(eq(productionItems.id, id));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting production item:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
