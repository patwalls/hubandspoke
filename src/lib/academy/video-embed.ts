/**
 * Turns a share link (Loom, YouTube, Vimeo, Google Drive) into an embeddable
 * player URL for the Academy. Returns null for anything else — the page then
 * shows a plain "Open video" link instead of a player.
 */
export function videoEmbedUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  const path = url.pathname;
  const id = (re: RegExp) => path.match(re)?.[1] ?? null;

  switch (host) {
    case "loom.com": {
      const v = id(/^\/(?:share|embed)\/([\w-]+)/);
      return v ? `https://www.loom.com/embed/${v}` : null;
    }
    case "youtube.com": {
      const v = path === "/watch" ? url.searchParams.get("v") : id(/^\/(?:shorts|embed|live)\/([\w-]+)/);
      return v && /^[\w-]+$/.test(v) ? `https://www.youtube.com/embed/${v}` : null;
    }
    case "youtu.be": {
      const v = id(/^\/([\w-]+)/);
      return v ? `https://www.youtube.com/embed/${v}` : null;
    }
    case "vimeo.com": {
      const v = id(/^\/(\d+)/);
      return v ? `https://player.vimeo.com/video/${v}` : null;
    }
    case "drive.google.com": {
      const v = id(/^\/file\/d\/([\w-]+)/);
      return v ? `https://drive.google.com/file/d/${v}/preview` : null;
    }
    default:
      return null;
  }
}

/** "1:09" / "01:02:03" → seconds, or null when it isn't a timestamp. */
export function timestampSeconds(time: string | null | undefined): number | null {
  if (!time) return null;
  const parts = time.trim().split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d{1,2}$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/**
 * Player URL that starts at a timestamp, for the clickable "you'll learn"
 * points. Loom takes ?t=<seconds>, YouTube ?start=, Vimeo #t=<s>s.
 */
export function embedUrlAt(embedUrl: string, seconds: number): string {
  if (embedUrl.includes("player.vimeo.com")) return `${embedUrl}#t=${seconds}s`;
  const key = embedUrl.includes("youtube.com") ? "start" : "t";
  const sep = embedUrl.includes("?") ? "&" : "?";
  return `${embedUrl}${sep}${key}=${seconds}&autoplay=1`;
}
