/**
 * Meta's CDN (fbcdn.net, cdninstagram.com) sets `CORP: same-origin` on
 * avatar responses, so browsers refuse to render them cross-origin from
 * our app. Route those through our `/api/image-proxy` route, which
 * re-fetches server-side and serves the bytes back same-origin.
 *
 * Other hosts (LinkedIn's media-licdn.com, X's pbs.twimg.com, TikTok's
 * tiktokcdn.com) don't have this restriction — pass them through.
 *
 * Usage: any `<img src>` that points at a user-supplied avatar URL should
 * pipe through this. The accounts table avatar (`AccountAvatar`) and the
 * preview-simulator avatar (`MonogramAvatar`) both use it.
 */
export function displayAvatarUrl(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    if (host.endsWith(".fbcdn.net") || host.endsWith(".cdninstagram.com")) {
      return `/api/image-proxy?url=${encodeURIComponent(raw)}`;
    }
    return raw;
  } catch {
    return raw;
  }
}
