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
