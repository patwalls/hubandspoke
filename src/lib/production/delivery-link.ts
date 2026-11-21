// "↗ YouTube Studio" on a Review row of the In Production list: the editors
// who hand work back do it with a link in a comment (the upload in YouTube
// Studio, the Canva design, the Typefully draft). The reviewer walking the
// Review group gets that link on the row instead of opening the post and
// scrolling to the comment. URL/host parsing only (structural); comment
// meaning is never classified here.

export interface DeliveryLink {
  url: string;
  /** "YouTube Studio", "Canva", … or the bare host. */
  label: string;
  /** The commenter's first name, if known. */
  by: string | null;
  /** ISO time of the comment. */
  at: string;
}

export interface LinkComment {
  body: string;
  at: Date;
  by: string | null;
}

/** A comment left this long before the status move still counts: editors
 *  often comment just before moving the post to Review. */
export const DELIVERY_GRACE_MS = 10 * 60 * 1000;

const LABELS: [RegExp, string][] = [
  [/^studio\.youtube\.com$/, "YouTube Studio"],
  [/^(www\.|m\.)?youtube\.com$|^youtu\.be$/, "YouTube"],
  [/^(www\.)?canva\.(com|link)$/, "Canva"],
  [/^(www\.)?typefully\.com$/, "Typefully"],
  [/^docs\.google\.com$/, "Google Doc"],
  [/^drive\.google\.com$/, "Drive"],
  [/^(www\.|app\.)?frame\.io$|^f\.io$/, "Frame.io"],
  [/^(www\.)?loom\.com$/, "Loom"],
  [/^(www\.)?dropbox\.com$/, "Dropbox"],
  [/^(www\.)?descript\.com$|^share\.descript\.com$/, "Descript"],
];

export function deliveryLabel(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [re, label] of LABELS) if (re.test(host)) return label;
  return host.replace(/^www\./, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The http(s) links in a comment body (the comment editor stores HTML;
 *  synced Notion comments may be plain text), in order. */
export function linksInComment(body: string): string[] {
  const out: string[] = [];
  const hrefs = [...body.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].map((m) => decodeEntities(m[1]));
  const found = hrefs.length > 0 ? hrefs : [...body.matchAll(/https?:\/\/[^\s<>"']+/gi)].map((m) => m[0]);
  for (const raw of found) {
    const url = raw.trim();
    if (/^https?:\/\//i.test(url) && deliveryLabel(url) && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The newest link left since the post entered its current status (minus
 *  the grace), from the newest comment that has one; its last link when it
 *  has several. Null when none — the row shows nothing. */
export function pickDeliveryLink(
  comments: readonly LinkComment[],
  statusSince: Date | null,
): DeliveryLink | null {
  const from = statusSince ? statusSince.getTime() - DELIVERY_GRACE_MS : -Infinity;
  const newestFirst = [...comments]
    .filter((c) => Number.isFinite(c.at.getTime()) && c.at.getTime() >= from)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const c of newestFirst) {
    const links = linksInComment(c.body);
    if (links.length === 0) continue;
    const url = links[links.length - 1];
    return { url, label: deliveryLabel(url)!, by: c.by, at: c.at.toISOString() };
  }
  return null;
}

/**
 * The public link a YouTube Studio delivery link will have once it's live.
 * The outside editors hand Shorts back as a Studio link
 * (studio.youtube.com/video/<id>/edit), and the reviewer then pastes
 * youtube.com/shorts/<same id> when it goes out — 25 of 25 in 30 days had
 * the same id. So the Publish box can offer it in one click. Structural URL
 * parsing only. Null unless the link is a Studio video link and the post is a
 * YouTube Short or long-form video.
 */
export function liveLinkFromStudio(
  url: string | null | undefined,
  postType: string | null | undefined,
): string | null {
  if (!url || (postType !== "youtube_shorts" && postType !== "youtube_long")) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.hostname.toLowerCase() !== "studio.youtube.com") return null;
  const m = u.pathname.match(/^\/video\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  if (!m) return null;
  return postType === "youtube_shorts"
    ? `https://youtube.com/shorts/${m[1]}`
    : `https://www.youtube.com/watch?v=${m[1]}`;
}
