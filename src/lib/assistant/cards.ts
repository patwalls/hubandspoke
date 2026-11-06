/**
 * Result cards the assistant shows under its answer. Same idea as Starter
 * Story's Ask-the-Data cards: the model only decides WHAT to show (which
 * posts, in what order); the numbers and links on a card come straight from
 * the database, so they're always formatted the same and can't be misquoted.
 * Shared by the server (tools emit them) and the chat panel (renders them).
 */

export type ContentCard = {
  id: string;
  title: string | null;
  app_url: string;
  post_type: string | null;
  account: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
};

export type StatsCard = {
  label: string;
  range: string;
  totals: { posts: number; views: number; clicks: number; leads: number };
  breakdown: { name: string; posts: number; views: number }[];
};

export type CardBlock = { kind: "content"; heading: string | null; items: ContentCard[] } | { kind: "stats"; stats: StatsCard };

const POST_TYPE_LABELS: Record<string, string> = {
  youtube_long: "YouTube",
  youtube_shorts: "YouTube Short",
  youtube_community: "YouTube Community",
  instagram_reel: "Instagram Reel",
  instagram_post: "Instagram Post",
  instagram_story: "Instagram Story",
  tiktok: "TikTok",
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  newsletter: "Newsletter",
  facebook_reel: "Facebook Reel",
  facebook_post: "Facebook Post",
};

export function postTypeLabel(postType: string | null | undefined): string {
  if (!postType) return "Post";
  return (
    POST_TYPE_LABELS[postType] ??
    postType
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  );
}

/** 1090000 → "1.09M", 44700 → "44.7K", 950 → "950". */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: n >= 1_000_000 ? 2 : 1 }).format(n);
}
