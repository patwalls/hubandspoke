import type { PostType } from "@/lib/platform-field-schemas";
import type { Platform } from "@/lib/platforms";
import type { AccountWithBrand } from "@/lib/db/accounts";

/**
 * Infer a canonical post_type from a published URL. Returns null when the
 * URL is unrecognized (or not a URL at all) — callers should fall back to
 * the account's default post_type.
 *
 *   youtube.com/shorts/{id}   → youtube_shorts
 *   youtube.com/post/... |
 *     /channel/.../community  → youtube_community
 *   youtube.com/watch |
 *     youtu.be/{id}           → youtube_long
 *   instagram.com/(reel|reels)/→ instagram_reel
 *   instagram.com/p/          → instagram_post
 *   instagram.com/stories/    → instagram_story
 *   x.com|twitter.com/…/status→ x
 *   tiktok.com/…/video | /t/  → tiktok
 *   linkedin.com/posts/ |
 *     /feed/update/           → linkedin
 *   threads.net/…             → threads
 */
export function inferPostTypeFromUrl(
  url: string | null | undefined
): PostType | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.toLowerCase();

  // YouTube family
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (path.startsWith("/shorts/")) return "youtube_shorts";
    if (path.startsWith("/post/") || path.includes("/community")) return "youtube_community";
    if (path.startsWith("/watch") || path.startsWith("/live/") || path.startsWith("/embed/")) return "youtube_long";
    return null;
  }
  if (host === "youtu.be") return "youtube_long";

  // Instagram
  if (host === "instagram.com") {
    if (path.startsWith("/reel/") || path.startsWith("/reels/")) return "instagram_reel";
    if (path.startsWith("/p/")) return "instagram_post";
    if (path.startsWith("/stories/")) return "instagram_story";
    if (path.startsWith("/tv/")) return "instagram_reel"; // IGTV → reel
    return null;
  }

  // X / Twitter
  if (host === "x.com" || host === "twitter.com") {
    if (path.includes("/status/")) return "x";
    return "x"; // profile URL etc. still maps to x
  }

  // TikTok
  if (host === "tiktok.com" || host === "vm.tiktok.com") {
    if (path.includes("/video/") || path.startsWith("/t/")) return "tiktok";
    return "tiktok";
  }

  // LinkedIn
  if (host === "linkedin.com") {
    if (path.startsWith("/posts/") || path.startsWith("/feed/update/")) return "linkedin";
    return "linkedin";
  }

  // Threads
  if (host === "threads.net" || host === "threads.com") return "threads";

  return null;
}

/**
 * Decide whether the AccountPostTypePicker should auto-apply a post type
 * inferred from the item's published URL. Returns the post type to apply,
 * or null when nothing should change.
 *
 * Never overrides an existing post type: the stored value is authoritative
 * and the URL shape is only a hint. YouTube Shorts in particular can be
 * synced with a `watch?v=` link — inferring from that URL would say
 * youtube_long, and auto-applying it used to silently rewrite a Short to
 * long-form every time someone opened the page (with no way to undo it,
 * since the picker is account-locked on synced YT items).
 */
export function resolveAutoPostType(opts: {
  currentPostType: string | null | undefined;
  publishedLink: string | null | undefined;
  accountPlatform: string;
}): PostType | null {
  if (opts.currentPostType) return null;
  const inferred = inferPostTypeFromUrl(opts.publishedLink);
  if (!inferred) return null;
  const platformOfInferred = inferred.startsWith("youtube_")
    ? "youtube"
    : inferred.startsWith("instagram_")
      ? "instagram"
      : inferred;
  if (platformOfInferred !== opts.accountPlatform) return null;
  return inferred;
}

/**
 * Best-effort account resolution from a URL. Matches:
 *   1. the URL's host against the platform set, then
 *   2. the first path segment (minus @) against handle,
 *      case-insensitive.
 * Returns null if either step fails — caller decides what to do (show a
 * "couldn't match" hint, or just leave the picker empty).
 */
export function inferAccountFromUrl(
  url: string | null | undefined,
  accounts: AccountWithBrand[]
): AccountWithBrand | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const platform: Platform | null =
    host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be" ? "youtube" :
    host === "instagram.com" ? "instagram" :
    host === "x.com" || host === "twitter.com" ? "x" :
    host === "tiktok.com" || host === "vm.tiktok.com" ? "tiktok" :
    host === "linkedin.com" ? "linkedin" :
    host === "threads.net" || host === "threads.com" ? "threads" :
    null;
  if (!platform) return null;

  // First path segment is usually the handle (leading "@" or "in/" on
  // LinkedIn). Strip those so we can match against stored handles.
  const segments = u.pathname.split("/").filter(Boolean);
  let handleSegment = segments[0] ?? "";
  if (platform === "linkedin" && segments[0] === "in" && segments[1]) handleSegment = segments[1];
  handleSegment = handleSegment.replace(/^@/, "").toLowerCase();

  const candidates = accounts.filter((a) => a.platform === platform && a.isActive);
  const exact = candidates.find((a) => a.handle.toLowerCase() === handleSegment);
  if (exact) return exact;
  // Fall back to the first active account on that platform — better to show
  // something than nothing for un-owned URLs from the same platform.
  return candidates[0] ?? null;
}
