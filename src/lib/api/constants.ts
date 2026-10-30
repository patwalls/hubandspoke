/** Dependency-free constants shared by the read model, the registry and the docs UI (client-safe). */
export const CONTENT_SORTS = ["published_at", "updated_at", "views"] as const;
export type ContentSort = (typeof CONTENT_SORTS)[number];
export const SOURCE_TYPES = ["original", "repurposed", "cross_post", "repost"] as const;
export const POST_TYPES = [
  "youtube_long",
  "youtube_shorts",
  "youtube_community",
  "instagram_reel",
  "instagram_post",
  "instagram_story",
  "x",
  "tiktok",
  "linkedin",
  "threads",
  "newsletter",
] as const;
export const API_VERSION = "1.0.0";
