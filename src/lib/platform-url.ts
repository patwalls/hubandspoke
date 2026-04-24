/**
 * URL ↔ platform-content-id helpers. The single source of truth for:
 *   - turning a published URL into a platform-native content id
 *   - producing one canonical URL shape per (platform, code)
 *   - producing a "loose key" to dedup URLs that differ only in query
 *     string, trailing slash, www, or threads.com vs threads.net
 *
 * Why it exists: dedup of `productionItems` was breaking when the same
 * post arrived twice via different paths — manual "Add from link" stored a
 * URL with `?utm_source=...`, auto-sync stored the canonical form, and
 * exact-string equality treated them as different rows. Centralizing
 * extraction here means every write path agrees on the dedup key.
 */

export type PlatformKey =
  | "youtube"
  | "instagram"
  | "threads"
  | "x"
  | "tiktok"
  | "linkedin";

/**
 * Coerce a fine-grained postType (`instagram_reel`, `youtube_shorts`) or a
 * coarse platform (`instagram`, `youtube`) into the coarse key used for URL
 * parsing. `twitter` collapses to `x`. Returns null for newsletters / other
 * non-social platforms whose URLs we don't try to parse.
 */
export function platformOf(
  postTypeOrPlatform: string | null | undefined
): PlatformKey | null {
  if (!postTypeOrPlatform) return null;
  const k = postTypeOrPlatform.toLowerCase();
  if (k.startsWith("youtube")) return "youtube";
  if (k.startsWith("instagram")) return "instagram";
  if (k === "threads") return "threads";
  if (k === "x" || k === "twitter") return "x";
  if (k === "tiktok") return "tiktok";
  if (k === "linkedin") return "linkedin";
  return null;
}

/**
 * Extract the platform-native content id from a published URL. Returns null
 * when the URL doesn't match a known shape — caller should leave the column
 * NULL rather than guess.
 *
 *   YouTube  → 11-char video id from `?v=`, `/shorts/`, `/embed/`, `youtu.be/`
 *   IG       → shortcode after `/p/`, `/reel/`, `/reels/`, or `/tv/`
 *   Threads  → code after `/post/`
 *   X        → numeric id after `/status/`
 *   TikTok   → numeric id after `/video/`
 *   LinkedIn → activity id from `activity-:id`, `activity::id`, or `urn:li:…`
 */
export function extractContentId(
  postTypeOrPlatform: string | null | undefined,
  url: string | null | undefined
): string | null {
  if (!url) return null;
  const platform = platformOf(postTypeOrPlatform);
  if (!platform) return null;
  switch (platform) {
    case "youtube": {
      const m = url.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([\w-]{11})/);
      return m?.[1] ?? null;
    }
    case "instagram": {
      const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      return m?.[1] ?? null;
    }
    case "threads": {
      const m = url.match(/\/post\/([A-Za-z0-9_-]+)/);
      return m?.[1] ?? null;
    }
    case "x": {
      const m = url.match(/\/status\/(\d+)/);
      return m?.[1] ?? null;
    }
    case "tiktok": {
      const m = url.match(/\/video\/(\d+)/);
      return m?.[1] ?? null;
    }
    case "linkedin": {
      const activity = url.match(/activity[:-](\d+)/);
      if (activity) return activity[1];
      const urn = url.match(/urn:li:(?:activity|share):(\d+)/);
      return urn?.[1] ?? null;
    }
  }
}

/**
 * One canonical URL shape per (platform, code). Used when writing fresh rows
 * and when the cleanup script normalizes legacy `published_link` values so
 * the dashboard never shows two rows that differ only in domain or query
 * string.
 */
export function canonicalPostUrl(
  postTypeOrPlatform: string | null | undefined,
  args: { code: string; handle?: string | null }
): string | null {
  const platform = platformOf(postTypeOrPlatform);
  if (!platform) return null;
  const handle = args.handle?.replace(/^@/, "") ?? null;
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/p/${args.code}/`;
    case "threads":
      return handle
        ? `https://www.threads.net/@${handle}/post/${args.code}`
        : `https://www.threads.net/post/${args.code}`;
    case "x":
      return handle
        ? `https://x.com/${handle}/status/${args.code}`
        : `https://x.com/i/status/${args.code}`;
    case "tiktok":
      return handle
        ? `https://www.tiktok.com/@${handle}/video/${args.code}`
        : `https://www.tiktok.com/video/${args.code}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=${args.code}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/update/urn:li:activity:${args.code}/`;
  }
}

/**
 * Loose URL key for fallback dedup when neither side has a `platform_content_id`
 * we can extract (rare — short links, custom domains). Strips query string,
 * fragment, trailing slash, leading `www.`, and folds `threads.com` →
 * `threads.net`. Returns null for inputs that don't parse as URLs.
 */
export function looseUrlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/^threads\.com$/, "threads.net");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.toLowerCase().split(/[?#]/)[0].replace(/\/+$/, "") || null;
  }
}
