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
  | "linkedin"
  | "facebook";

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
  if (k === "facebook" || k.startsWith("facebook_")) return "facebook";
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
    case "facebook": {
      // /posts/<id> or /videos/<id>
      const m = url.match(/\/(?:posts|videos)\/(\d+)/);
      return m?.[1] ?? null;
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
    case "facebook":
      return handle
        ? `https://www.facebook.com/${handle}/posts/${args.code}`
        : `https://www.facebook.com/permalink.php?story_fbid=${args.code}`;
  }
}

/**
 * Detect the platform from a URL's hostname. Used when a user pastes a link
 * without telling us what kind of post it is (e.g. global search).
 */
export function inferPlatformFromUrl(
  url: string | null | undefined
): PlatformKey | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be")
    return "youtube";
  if (host === "instagram.com") return "instagram";
  if (host === "threads.net" || host === "threads.com") return "threads";
  if (host === "x.com" || host === "twitter.com") return "x";
  if (host === "tiktok.com" || host === "vm.tiktok.com") return "tiktok";
  if (host === "linkedin.com") return "linkedin";
  if (host === "facebook.com" || host === "fb.com" || host === "m.facebook.com") return "facebook";
  return null;
}

/**
 * Convenience: extract the platform-native content id from a bare URL by
 * first inferring the platform from the hostname.
 */
export function extractContentIdFromUrl(
  url: string | null | undefined
): { platform: PlatformKey; contentId: string } | null {
  const platform = inferPlatformFromUrl(url);
  if (!platform) return null;
  const contentId = extractContentId(platform, url);
  if (!contentId) return null;
  return { platform, contentId };
}

/**
 * Normalize whatever a user pastes into the "Handle" field for a LinkedIn
 * account into a stored `(handle, url)` pair.
 *
 * Why this exists: LinkedIn is the one platform where the account *kind*
 * (company page vs personal profile) is load-bearing and lives in the URL —
 * content-sync only works for company pages (`/v1/linkedin/company/posts`)
 * and refuses anything whose stored `url` doesn't contain `/company/`. The
 * create form only collects a single free-text field, so we parse the kind
 * out of it here and persist a canonical `url` the sync paths can rely on.
 *
 * Crucially, Scrape Creators (our data provider) **rejects numeric company
 * IDs** — `linkedin.com/company/27061078` 400s with "use the company's URL
 * slug instead". The admin dashboard URL is exactly that numeric form, so we
 * catch it and return a help message instead of silently storing an account
 * that will fail every sync and get auto-deactivated.
 *
 * Accepts: full profile/company URLs, admin URLs (slug is taken from the
 * `/company/<slug>/admin/...` prefix), bare `company/<slug>` / `in/<slug>`,
 * and a bare handle (left as-is, url null — refresh probes both kinds).
 */
export type LinkedInAccountInput =
  | { ok: true; handle: string; url: string; kind: "company" | "personal" }
  | { ok: true; handle: string; url: null; kind: "bare" }
  | { ok: false; error: string };

export function parseLinkedInAccountInput(raw: string): LinkedInAccountInput {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, error: "handle cannot be empty" };

  const company =
    input.match(/linkedin\.com\/company\/([^/?#\s]+)/i) ??
    input.match(/^company\/([^/?#\s]+)/i);
  if (company) {
    const slug = company[1];
    if (/^\d+$/.test(slug)) {
      return {
        ok: false,
        error:
          "LinkedIn numeric company IDs aren't supported by our data provider. " +
          "Open the company's public page (not the admin dashboard) and use its " +
          "vanity URL, e.g. linkedin.com/company/hubspot.",
      };
    }
    return {
      ok: true,
      handle: slug,
      url: `https://www.linkedin.com/company/${slug}`,
      kind: "company",
    };
  }

  const personal =
    input.match(/linkedin\.com\/in\/([^/?#\s]+)/i) ??
    input.match(/^in\/([^/?#\s]+)/i);
  if (personal) {
    const slug = personal[1];
    return {
      ok: true,
      handle: slug,
      url: `https://www.linkedin.com/in/${slug}`,
      kind: "personal",
    };
  }

  return { ok: true, handle: input.replace(/^@/, ""), url: null, kind: "bare" };
}

/**
 * Normalize whatever a user pastes into the Handle field for a Facebook
 * account into a stored `(handle, url)` pair.
 *
 * SC's Facebook endpoints require a full page URL (not just a handle), so
 * we store the canonical URL in `accounts.url` and extract the slug as the
 * handle for display. Accepts full URLs or bare page slugs.
 */
export type FacebookAccountInput =
  | { ok: true; handle: string; url: string }
  | { ok: false; error: string };

export function parseFacebookAccountInput(raw: string): FacebookAccountInput {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, error: "handle cannot be empty" };

  // Full URL — extract the first path segment as the slug.
  const urlMatch = input.match(/facebook\.com\/([^/?#\s]+)/i);
  if (urlMatch) {
    const slug = urlMatch[1];
    // Skip generic Facebook paths
    if (["pages", "groups", "events", "marketplace", "watch", "profile.php"].includes(slug.toLowerCase())) {
      return {
        ok: false,
        error: "Enter the Facebook page URL (e.g. facebook.com/starterstory), not a generic Facebook path.",
      };
    }
    return {
      ok: true,
      handle: slug,
      url: `https://www.facebook.com/${slug}`,
    };
  }

  // Bare slug — treat as a page name directly.
  const slug = input.replace(/^@/, "");
  return {
    ok: true,
    handle: slug,
    url: `https://www.facebook.com/${slug}`,
  };
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
