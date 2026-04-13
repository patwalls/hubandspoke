import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";

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
