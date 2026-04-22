import type { PlatformKey } from "@/lib/platform-field-schemas";

export type EmbedResolution =
  | { kind: "iframe"; src: string; aspect: "portrait" | "square" | "video" | "landscape" }
  | { kind: "script"; script: string; html: string }
  | { kind: "link-only"; href: string }
  | { kind: "none" };

function safeURL(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function extractInstagramShortcode(url: URL): string | null {
  // /p/{code}/ or /reel/{code}/ or /tv/{code}/ — handles optional trailing slash
  const m = url.pathname.match(/\/(?:p|reel|tv)\/([^/?]+)/);
  return m ? m[1] : null;
}

function extractTwitterStatusId(url: URL): string | null {
  const m = url.pathname.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

function extractYouTubeId(url: URL): string | null {
  if (url.hostname.endsWith("youtu.be")) {
    const id = url.pathname.slice(1).split("/")[0];
    return id || null;
  }
  const shortsMatch = url.pathname.match(/\/shorts\/([^/?]+)/);
  if (shortsMatch) return shortsMatch[1];
  const vParam = url.searchParams.get("v");
  if (vParam) return vParam;
  const embedMatch = url.pathname.match(/\/embed\/([^/?]+)/);
  if (embedMatch) return embedMatch[1];
  return null;
}

function extractTikTokVideoId(url: URL): string | null {
  const m = url.pathname.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

function extractThreadsPost(url: URL): { handle: string; postId: string } | null {
  // Matches both /@handle/post/ID and /@handle/post/ID/ and with query params.
  const m = url.pathname.match(/\/@([^/]+)\/post\/([^/?]+)/);
  return m ? { handle: m[1], postId: m[2] } : null;
}

export function resolveEmbed(
  platform: PlatformKey,
  publishedLink: string | null,
): EmbedResolution {
  const url = safeURL(publishedLink);
  if (!url || !publishedLink) return { kind: "none" };

  switch (platform) {
    case "instagram_post":
    case "instagram_reel":
    case "instagram_story": {
      const code = extractInstagramShortcode(url);
      if (!code) return { kind: "link-only", href: publishedLink };
      return {
        kind: "iframe",
        src: `https://www.instagram.com/p/${code}/embed/captioned`,
        aspect: platform === "instagram_reel" ? "portrait" : "portrait",
      };
    }
    case "x": {
      const id = extractTwitterStatusId(url);
      if (!id) return { kind: "link-only", href: publishedLink };
      return {
        kind: "script",
        script: "https://platform.twitter.com/widgets.js",
        html: `<blockquote class="twitter-tweet"><a href="${publishedLink}"></a></blockquote>`,
      };
    }
    case "youtube_long":
    case "youtube_shorts": {
      const id = extractYouTubeId(url);
      if (!id) return { kind: "link-only", href: publishedLink };
      return {
        kind: "iframe",
        src: `https://www.youtube.com/embed/${id}`,
        aspect: platform === "youtube_shorts" ? "portrait" : "video",
      };
    }
    case "tiktok": {
      const id = extractTikTokVideoId(url);
      if (!id) return { kind: "link-only", href: publishedLink };
      return {
        kind: "script",
        script: "https://www.tiktok.com/embed.js",
        html: `<blockquote class="tiktok-embed" cite="${publishedLink}" data-video-id="${id}" style="max-width: 420px; min-width: 300px;"><section></section></blockquote>`,
      };
    }
    case "threads": {
      const parts = extractThreadsPost(url);
      if (!parts) return { kind: "link-only", href: publishedLink };
      return {
        kind: "iframe",
        src: `https://www.threads.net/@${parts.handle}/post/${parts.postId}/embed`,
        aspect: "portrait",
      };
    }
    case "linkedin":
      // LinkedIn's embed iframe wants a URN, not a post URL, and there's no
      // reliable URN→URL mapping from the public URL alone. Link-out only.
      return { kind: "link-only", href: publishedLink };
    case "newsletter":
      return { kind: "link-only", href: publishedLink };
  }
}
