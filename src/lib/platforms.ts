import type { PostType } from "@/lib/platform-field-schemas";

// Canonical platform key. Mirrors the values seeded into `accounts.platform`.
export type Platform =
  | "youtube"
  | "instagram"
  | "x"
  | "tiktok"
  | "linkedin"
  | "threads"
  | "newsletter"
  | "other";

export interface PlatformMeta {
  /** User-facing platform name (dropdown headers, filter labels). */
  label: string;
  /**
   * Post types this platform supports. Empty for "other" (no post-type
   * picker is rendered for that bucket).
   */
  postTypes: PostType[];
  /**
   * The post type applied when an account on this platform is picked for
   * the first time (before the user changes it). Null only for `other`.
   */
  defaultPostType: PostType | null;
  /** Tailwind text-color class for the platform icon (brand-adjacent). */
  colorClass: string;
}

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  youtube: {
    label: "YouTube",
    postTypes: ["youtube_long", "youtube_shorts", "youtube_community"],
    defaultPostType: "youtube_long",
    colorClass: "text-red-600",
  },
  instagram: {
    label: "Instagram",
    postTypes: ["instagram_reel", "instagram_post", "instagram_story"],
    defaultPostType: "instagram_reel",
    colorClass: "text-pink-600",
  },
  x: {
    label: "X",
    postTypes: ["x"],
    defaultPostType: "x",
    colorClass: "text-foreground",
  },
  tiktok: {
    label: "TikTok",
    postTypes: ["tiktok"],
    defaultPostType: "tiktok",
    colorClass: "text-sky-600",
  },
  linkedin: {
    label: "LinkedIn",
    postTypes: ["linkedin"],
    defaultPostType: "linkedin",
    colorClass: "text-blue-700",
  },
  threads: {
    label: "Threads",
    postTypes: ["threads"],
    defaultPostType: "threads",
    colorClass: "text-foreground",
  },
  newsletter: {
    label: "Newsletter",
    postTypes: ["newsletter"],
    defaultPostType: "newsletter",
    colorClass: "text-amber-600",
  },
  other: {
    label: "Other",
    postTypes: [],
    defaultPostType: null,
    colorClass: "text-muted-foreground",
  },
};

/** Short, platform-specific label for a post type ("Short" / "Reel" /
 *  "Long form" / …). Used in AccountBadge when the platform has >1 post
 *  type and the current one isn't the default. */
export const POST_TYPE_SHORT_LABEL: Record<PostType, string> = {
  youtube_long: "Long form",
  youtube_shorts: "Short",
  youtube_community: "Community",
  instagram_reel: "Reel",
  instagram_post: "Post",
  instagram_story: "Story",
  x: "Post",
  tiktok: "Video",
  linkedin: "Post",
  threads: "Post",
  newsletter: "Issue",
};

/** True if the platform distinguishes multiple post types. AccountBadge uses
 *  this to decide whether to render the `· Short` suffix. */
export function platformHasMultiplePostTypes(platform: Platform): boolean {
  return PLATFORM_META[platform].postTypes.length > 1;
}

/** Narrow a free string from the DB into a `Platform`. Returns "other" for
 *  unknown values so callers never have to null-check. */
export function toPlatform(raw: string | null | undefined): Platform {
  if (!raw) return "other";
  const v = raw.toLowerCase();
  if (v in PLATFORM_META) return v as Platform;
  return "other";
}
