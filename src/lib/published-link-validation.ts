import { inferPlatformFromUrl, platformOf } from "./platform-url";

/**
 * Returns null when the published_link host matches the row's post-type
 * platform (or when either side is unresolvable). Returns an error message
 * when both sides resolve to *different* platforms.
 *
 * Tolerant by design — newsletters, custom-domain links, and other shapes
 * we don't recognize bail out as null. The point is to catch obvious
 * mistakes (e.g. saving a threads.com link onto an X-tagged row), not to
 * police every URL.
 */
export function validatePublishedLinkPlatform(
  url: string | null | undefined,
  postTypeOrPlatform: string | null | undefined,
): string | null {
  if (!url || !postTypeOrPlatform) return null;
  const linkPlatform = inferPlatformFromUrl(url);
  const rowPlatform = platformOf(postTypeOrPlatform);
  if (!linkPlatform || !rowPlatform) return null;
  if (linkPlatform === rowPlatform) return null;
  return `Published link is a ${linkPlatform} URL but this post is set up as ${rowPlatform}. Update the account/post-type or fix the link.`;
}

/**
 * Share/short links that never bring back views. The metrics sync reads a
 * post by its own URL (or the account sync matches it by its URL / content
 * id); a share link is a redirect with neither, so the post sits at "no
 * views" forever and drops out of every report. Facebook's "Share → Copy
 * link" (facebook.com/share/p|r|v/…) left 32 posts without views in 21 days
 * (2026-11); lnkd.in links fail the LinkedIn lookup the same way.
 *
 * Structural URL handling only (host + path shape). Returns a warning the
 * paste boxes show and ask to confirm once, or null for a normal link.
 */
export function shareLinkWarning(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|web)\./, "");
  if (host === "facebook.com" && /^\/share\//.test(u.pathname)) {
    return "This is a Facebook share link — it won't bring back views. Open the post and copy its own link (facebook.com/…/posts/… or /reel/…).";
  }
  if (host === "fb.watch") {
    return "This is a Facebook short link — it won't bring back views. Open the post and copy its own link (facebook.com/…/posts/… or /reel/…).";
  }
  if (host === "lnkd.in") {
    return "This is a LinkedIn short link — it won't bring back views. Open the post and copy its own link (linkedin.com/feed/update/…).";
  }
  return null;
}

/**
 * What the Publish dialog's link box shows before anything is pasted: the
 * shape of a real link on the post's own platform, so a LinkedIn post
 * doesn't ask for "https://x.com/…". Structural only (post type → URL
 * shape the metrics sync reads); unknown or empty post types get a neutral
 * "https://…".
 */
export function publishLinkPlaceholder(postType: string | null | undefined): string {
  const k = (postType ?? "").toLowerCase();
  switch (k) {
    case "youtube_shorts":
      return "https://youtube.com/shorts/…";
    case "youtube_community":
      return "https://youtube.com/post/…";
    case "instagram_post":
      return "https://instagram.com/p/…";
    case "instagram_story":
      return "https://instagram.com/stories/…";
  }
  switch (platformOf(postType)) {
    case "youtube":
      return "https://youtube.com/watch?v=…";
    case "instagram":
      return "https://instagram.com/reel/…";
    case "x":
      return "https://x.com/…/status/…";
    case "tiktok":
      return "https://tiktok.com/@…/video/…";
    case "linkedin":
      return "https://linkedin.com/feed/update/…";
    case "threads":
      return "https://threads.com/@…/post/…";
    case "facebook":
      return "https://facebook.com/…/posts/…";
    default:
      return "https://…";
  }
}
