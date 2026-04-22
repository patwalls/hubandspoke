// Best-effort cover image for a production item. Priority:
//   1. posterUrl (presigned S3, durable — videos archive a poster here)
//   2. mediaUrl (presigned S3) when mediaContentType is an image (IG photo posts
//      store the cover as the main media, not a separate poster)
//   3. thumbnail (upstream CDN URL — works initially but IG CDN URLs expire)
//
// Everything is optional; callers pass whatever they have. Returns null when no
// source is usable so the call site can hide the <img> instead of rendering a
// broken icon.

export interface CoverSource {
  posterUrl?: string | null;
  mediaUrl?: string | null;
  mediaContentType?: string | null;
  thumbnail?: string | null;
}

export function coverImageUrl(item: CoverSource): string | null {
  if (item.posterUrl) return item.posterUrl;
  if (item.mediaUrl && item.mediaContentType?.startsWith("image/")) {
    return item.mediaUrl;
  }
  return item.thumbnail ?? null;
}
