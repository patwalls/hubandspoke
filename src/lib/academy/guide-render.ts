import { videoEmbedUrl } from "@/lib/academy/video-embed";

// Browser-safe half of guide-html.ts (no sanitize-html import), so the video
// page can render the guide without shipping the sanitizer to the client.

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Sanitized guide HTML → page HTML: video placeholders become 16:9 players. */
export function renderGuideHtml(html: string): string {
  return html.replace(/<div data-video-embed="([^"]*)"><\/div>/g, (_m, raw: string) => {
    const src = videoEmbedUrl(decode(raw));
    if (!src) return "";
    return `<div class="academy-guide-video"><iframe src="${escapeAttr(src)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  });
}
