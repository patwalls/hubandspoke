/**
 * YouTube sync service for MATG.
 *
 * Uses the Scrape Creators API to pull video data from the MATG YouTube channel
 * and upserts it into the production_items table.
 */

import { db } from "@/lib/db";
import { productionItems, syncLogs } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { resolveAssignees } from "@/lib/services/assignees";
import { generateUtmCampaign } from "@/lib/utm-campaign";

const SCRAPE_CREATORS_BASE = "https://api.scrapecreators.com/v1/youtube";
const MATG_HANDLE = "MATGpod";

function apiKey() {
  const key = process.env.SCRAPE_CREATORS_API_KEY;
  if (!key) throw new Error("SCRAPE_CREATORS_API_KEY is not set");
  return key;
}

/* ------------------------------------------------------------------ */
/*  Scrape Creators API types                                          */
/* ------------------------------------------------------------------ */

interface SCVideo {
  type: string;
  id: string;
  url: string;
  title: string;
  description?: string;
  thumbnail: string;
  channel: { title: string; thumbnail: string | null };
  viewCountText: string;
  viewCountInt: number;
  publishedTimeText: string;
  publishedTime?: string;
  lengthText: string;
  lengthSeconds: number;
  badges: string[];
}

interface SCChannelVideosResponse {
  videos: SCVideo[];
  continuationToken?: string;
}

/* ------------------------------------------------------------------ */
/*  Fetch videos from Scrape Creators                                  */
/* ------------------------------------------------------------------ */

async function fetchChannelVideos(
  handle: string,
  sort: "latest" | "popular" = "latest"
): Promise<SCVideo[]> {
  const url = `${SCRAPE_CREATORS_BASE}/channel-videos?handle=${handle}&sort=${sort}`;
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey() },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Scrape Creators API error (${res.status}): ${err}`);
  }

  const data: SCChannelVideosResponse = await res.json();
  return data.videos || [];
}

/* ------------------------------------------------------------------ */
/*  Parse relative time strings into approximate dates                 */
/* ------------------------------------------------------------------ */

function parseRelativeTime(text: string): string | null {
  if (!text) return null;

  const now = new Date();
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;

  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "second":
      now.setSeconds(now.getSeconds() - num);
      break;
    case "minute":
      now.setMinutes(now.getMinutes() - num);
      break;
    case "hour":
      now.setHours(now.getHours() - num);
      break;
    case "day":
      now.setDate(now.getDate() - num);
      break;
    case "week":
      now.setDate(now.getDate() - num * 7);
      break;
    case "month":
      now.setMonth(now.getMonth() - num);
      break;
    case "year":
      now.setFullYear(now.getFullYear() - num);
      break;
  }

  return now.toISOString().split("T")[0]; // YYYY-MM-DD
}

/* ------------------------------------------------------------------ */
/*  Main sync function                                                 */
/* ------------------------------------------------------------------ */

export interface YouTubeSyncResult {
  videosFetched: number;
  created: number;
  updated: number;
  errors: number;
}

export async function syncMATGYouTube(): Promise<YouTubeSyncResult> {
  const startedAt = new Date();
  const result: YouTubeSyncResult = {
    videosFetched: 0,
    created: 0,
    updated: 0,
    errors: 0,
  };

  try {
    // Fetch latest videos
    const videos = await fetchChannelVideos(MATG_HANDLE, "latest");
    result.videosFetched = videos.length;

    // Get existing MATG items by youtube_id
    const existing = await db
      .select({ id: productionItems.id, youtubeId: productionItems.youtubeId })
      .from(productionItems)
      .where(
        and(
          eq(productionItems.brand, "matg"),
          isNotNull(productionItems.youtubeId)
        )
      );

    const existingMap = new Map(
      existing.map((e) => [e.youtubeId, e.id])
    );

    for (const video of videos) {
      try {
        const publishedDate = video.publishedTime
          ? video.publishedTime.split("T")[0]
          : parseRelativeTime(video.publishedTimeText);
        const publishedAt = video.publishedTime
          ? new Date(video.publishedTime)
          : null;

        const videoData = {
          title: video.title,
          youtubeUrl: video.url,
          thumbnail: video.thumbnail,
          publishedDate,
          publishedAt,
          status: "Published",
          platform: ["YouTube"] as string[],
          format: "Business Interview", // default pillar format — editable in dashboard
          brand: "matg" as const,
          publishedLink: video.url,
          views: video.viewCountInt || 0,
          isExternal: false,
          updatedAt: new Date(),
        };

        if (existingMap.has(video.id)) {
          // Update existing
          await db
            .update(productionItems)
            .set(videoData)
            .where(eq(productionItems.id, existingMap.get(video.id)!));
          result.updated++;
        } else {
          // Insert new
          const assignees = await resolveAssignees({
            brand: "matg",
            format: "Business Interview",
          });
          await db.insert(productionItems).values({
            ...videoData,
            youtubeId: video.id,
            utmCampaign: await generateUtmCampaign(video.title),
            producerUserId: assignees.producerUserId,
            editorUserId: assignees.editorUserId,
          });
          result.created++;
        }
      } catch (err) {
        console.error(`Error processing video ${video.id}:`, err);
        result.errors++;
      }
    }

    // Log successful sync
    await db.insert(syncLogs).values({
      syncType: "youtube-matg",
      status: "success",
      itemsFetched: result.videosFetched,
      itemsCreated: result.created,
      itemsUpdated: result.updated,
      startedAt,
      completedAt: new Date(),
    });
  } catch (err) {
    // Log failed sync
    await db.insert(syncLogs).values({
      syncType: "youtube-matg",
      status: "error",
      errorMessage: String(err),
      startedAt,
      completedAt: new Date(),
    });
    throw err;
  }

  return result;
}
