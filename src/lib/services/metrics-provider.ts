/**
 * Pulse-first metric fetchers with ScrapeCreators fallback.
 *
 * Drop-in replacements for the seven single-URL fetchers in `sc-fetchers.ts`
 * that `refreshItemMetrics` (performance-decay, refresh-item-metrics task,
 * velocity snapshots) consumes. Same names, same signatures, same return
 * shapes — plus a `source` marker so callers can account credits correctly
 * (Pulse calls are free; SC calls cost 1 credit).
 *
 * Behavior:
 *   - `PULSE_METRICS_ENABLED` unset (the default, DARK) → straight delegation
 *     to the SC fetcher. Byte-for-byte the pre-Pulse behavior.
 *   - Flag on → try Pulse first; on ANY failure (network, rate-limit,
 *     login-wall, unusable/empty data) fall back to SC silently. Pulse runs on
 *     Pat's home machine behind a Cloudflare tunnel — it is expected to be
 *     down sometimes, and the fallback is the design, not an edge case.
 *   - A Pulse "post is gone" answer (content_unavailable) is NOT trusted as
 *     gone — we still confirm via SC (which 404s → null) so a Pulse quirk can
 *     never mark a live post as vanished.
 *
 * Views policy: Pulse estimates views from likes on platforms with no public
 * view counts (viewsEstimated: true). Hub&Spoke has its own estimator with its
 * own multipliers at the write site, so estimated views are DROPPED here and
 * the columns keep their existing semantics.
 */

import {
  fetchSingleVideo as scFetchSingleVideo,
  fetchTweetByUrl as scFetchTweetByUrl,
  fetchThreadsPostByUrl as scFetchThreadsPostByUrl,
  fetchLinkedInPostByUrl as scFetchLinkedInPostByUrl,
  fetchTikTokVideoByUrl as scFetchTikTokVideoByUrl,
  fetchYouTubeCommunityPostByUrl as scFetchYouTubeCommunityPostByUrl,
  fetchInstagramPostByUrl as scFetchInstagramPostByUrl,
  type SCVideoDetail,
  type SCTweet,
  type SCPostMetrics,
  type SCInstagramPostMetrics,
} from "./sc-fetchers";
import { pulseFetchMetrics, pulseMetricsEnabled, type PulsePostMetrics } from "./pulse-client";

export type MetricsSource = "pulse" | "sc";
export type WithSource<T> = T & { source: MetricsSource };

const tag = <T>(value: T, source: MetricsSource): WithSource<T> =>
  Object.assign({} as WithSource<T>, value, { source });

/** Real views only — Pulse's likes-derived estimates are the caller's job. */
const realViews = (m: PulsePostMetrics): number | null =>
  m.viewsEstimated ? null : m.views;

// ─── Pure mapping functions (exported for tests) ──────────────────────────────

export function mapPulseToVideoDetail(m: PulsePostMetrics): SCVideoDetail | null {
  // A YouTube read with no view count is not usable — SC always has views.
  if (m.views == null) return null;
  return {
    id: m.contentId,
    url: m.url,
    title: m.title ?? "",
    viewCountInt: m.views,
    likeCountInt: m.likes as number, // decay tolerates null here (likes ?? null)
    commentCountInt: m.comments as number, // abbreviated on Pulse (commentsEstimated) — accepted
    thumbnail: m.thumbnail ?? undefined,
    publishedAt: m.publishedAt,
  };
}

export function mapPulseToTweet(m: PulsePostMetrics): SCTweet | null {
  if (m.likes == null && m.views == null && m.comments == null) return null;
  return {
    __typename: "Tweet",
    rest_id: m.contentId,
    url: m.url,
    legacy: {
      full_text: m.title ?? "", // truncated at 200 by Pulse — metrics callers don't read it
      created_at: m.publishedAt ?? "", // ISO; decay's `new Date(created_at)` parses it fine
      favorite_count: m.likes as number,
      retweet_count: m.shares as number,
      reply_count: m.comments as number,
      bookmark_count: m.bookmarks as number,
      id_str: m.contentId,
    },
    views: m.views != null ? { count: String(m.views), state: "EnabledWithCount" } : undefined,
  };
}

export function mapPulseToPostMetrics(m: PulsePostMetrics): SCPostMetrics | null {
  const views = realViews(m);
  if (views == null && m.likes == null && m.comments == null) return null;
  return { views, likes: m.likes, comments: m.comments, publishedAt: m.publishedAt };
}

export function mapPulseToInstagramMetrics(m: PulsePostMetrics): SCInstagramPostMetrics | null {
  const views = realViews(m);
  if (views == null && m.likes == null && m.comments == null) return null;
  return {
    shortcode: m.contentId,
    views,
    likes: m.likes,
    comments: m.comments,
    thumbnail: m.thumbnail,
    publishedAt: m.publishedAt,
  };
}

// ─── The Pulse-first composition ──────────────────────────────────────────────

/**
 * Try Pulse, fall back to SC. `map` returns null when the Pulse answer carries
 * nothing usable (all engagement fields empty) — that also falls back.
 */
async function pulseFirst<T>(
  postUrl: string,
  map: (m: PulsePostMetrics) => T | null,
  scFallback: () => Promise<T | null>
): Promise<WithSource<T> | null> {
  if (pulseMetricsEnabled()) {
    try {
      const m = await pulseFetchMetrics(postUrl);
      if (m) {
        const mapped = map(m);
        if (mapped) return tag(mapped, "pulse");
      }
      // Pulse said "gone" (null) or gave an unusable answer → confirm via SC.
    } catch {
      // Pulse being down/limited/walled is expected — SC is the reliable path.
    }
  }
  const sc = await scFallback();
  return sc == null ? null : tag(sc, "sc");
}

// ─── Drop-in fetchers (same names/signatures as sc-fetchers) ──────────────────

export async function fetchSingleVideo(videoUrl: string): Promise<WithSource<SCVideoDetail>> {
  const result = await pulseFirst(videoUrl, mapPulseToVideoDetail, () => scFetchSingleVideo(videoUrl));
  // scFetchSingleVideo never returns null (it throws) — mirror that contract.
  if (!result) throw new Error(`fetchSingleVideo: no result for ${videoUrl}`);
  return result;
}

export async function fetchTweetByUrl(tweetUrl: string): Promise<WithSource<SCTweet> | null> {
  return pulseFirst(tweetUrl, mapPulseToTweet, () => scFetchTweetByUrl(tweetUrl));
}

export async function fetchThreadsPostByUrl(postUrl: string): Promise<WithSource<SCPostMetrics> | null> {
  return pulseFirst(postUrl, mapPulseToPostMetrics, () => scFetchThreadsPostByUrl(postUrl));
}

export async function fetchLinkedInPostByUrl(postUrl: string): Promise<WithSource<SCPostMetrics> | null> {
  return pulseFirst(postUrl, mapPulseToPostMetrics, () => scFetchLinkedInPostByUrl(postUrl));
}

export async function fetchTikTokVideoByUrl(videoUrl: string): Promise<WithSource<SCPostMetrics> | null> {
  return pulseFirst(videoUrl, mapPulseToPostMetrics, () => scFetchTikTokVideoByUrl(videoUrl));
}

export async function fetchYouTubeCommunityPostByUrl(postUrl: string): Promise<WithSource<SCPostMetrics> | null> {
  return pulseFirst(
    postUrl,
    // SC parity for community posts is likes-only; keep views/comments null so the
    // caller's partial-update spreads leave those columns alone.
    (m) => (m.likes == null ? null : { views: null, likes: m.likes, comments: null, publishedAt: null }),
    () => scFetchYouTubeCommunityPostByUrl(postUrl)
  );
}

export async function fetchInstagramPostByUrl(postUrl: string): Promise<WithSource<SCInstagramPostMetrics> | null> {
  return pulseFirst(postUrl, mapPulseToInstagramMetrics, () => scFetchInstagramPostByUrl(postUrl));
}

/** Credits actually spent by a provider fetch: Pulse is free, SC costs 1. */
export const creditsFor = (result: { source: MetricsSource } | null): number =>
  result == null || result.source === "sc" ? 1 : 0;
