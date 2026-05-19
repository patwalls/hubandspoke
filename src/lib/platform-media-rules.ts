/**
 * Per-platform media rules — the single source of truth for what media a
 * post type accepts and how its simulator frame is shaped.
 *
 * Read by:
 *   - `validateMediaForPostType` (server-side upload gate)
 *   - `dropZoneOptionsForPostType` (client-side dropzone UI hints)
 *   - The platform simulators under `src/components/dashboard/preview/platforms/*.tsx`
 *     for `aspectClass`
 *   - The repost / cross-post enrichment-when-missing-media gate (via
 *     `isVideoBearingPostType`)
 *
 * If you change a platform's media policy, change it ONLY here.
 */
import type { PostType } from "./platform-field-schemas";

export type MediaMode =
  /** No manual media on this platform yet — dropzone is hidden. */
  | "none"
  /** Exactly one video. Photos rejected. (Reel, TikTok) */
  | "single-video"
  /** Exactly one item, photo or video. (IG Story) */
  | "single-any"
  /** Up to N photos OR exactly 1 video, no mixing. (X, LinkedIn) */
  | "photos-or-video"
  /** Photos and videos, mixed, up to N. (IG Post carousel) */
  | "carousel-mixed";

export interface PlatformMediaRule {
  mode: MediaMode;
  /** Combined cap (existing + incoming) the validator enforces. */
  maxCount: number;
  /** Which kinds the dropzone accepts. Implied by `mode` but kept explicit
   *  so the validator doesn't need to know mode-specific shape. */
  allowedKinds: ReadonlyArray<"image" | "video">;
  /** MIME accept attribute for the file picker. Empty when `mode === "none"`. */
  accept: string;
  /** Button label for the dropzone "add" affordance. */
  addLabel: string;
  /** Label when the dropzone is at-cap on a single-* mode (drop replaces). */
  replaceLabel: string;
  /** Tailwind aspect-ratio class for the simulator media frame. Null when
   *  the simulator manages its own (the multi-aspect carousels). */
  aspectClass: string | null;
}

const IMAGE_VIDEO_ACCEPT =
  "image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime";
const IMAGE_VIDEO_NO_GIF_ACCEPT =
  "image/jpeg,image/png,video/mp4,video/quicktime";
const VIDEO_ONLY_ACCEPT = "video/mp4,video/quicktime";

export const PLATFORM_MEDIA_RULES: Record<PostType, PlatformMediaRule> = {
  x: {
    mode: "photos-or-video",
    maxCount: 4,
    allowedKinds: ["image", "video"],
    accept: IMAGE_VIDEO_ACCEPT,
    addLabel: "Add photo or video",
    replaceLabel: "Replace media",
    aspectClass: null,
  },
  instagram_post: {
    mode: "carousel-mixed",
    maxCount: 10,
    allowedKinds: ["image", "video"],
    accept: IMAGE_VIDEO_NO_GIF_ACCEPT,
    addLabel: "Add photo or video",
    replaceLabel: "Replace media",
    aspectClass: "aspect-square",
  },
  instagram_reel: {
    mode: "single-video",
    maxCount: 1,
    allowedKinds: ["video"],
    accept: VIDEO_ONLY_ACCEPT,
    addLabel: "Add video",
    replaceLabel: "Replace video",
    aspectClass: "aspect-[9/16]",
  },
  instagram_story: {
    mode: "single-any",
    maxCount: 1,
    allowedKinds: ["image", "video"],
    accept: IMAGE_VIDEO_NO_GIF_ACCEPT,
    addLabel: "Add photo or video",
    replaceLabel: "Replace media",
    aspectClass: "aspect-[9/16]",
  },
  linkedin: {
    mode: "photos-or-video",
    maxCount: 9,
    allowedKinds: ["image", "video"],
    accept: IMAGE_VIDEO_ACCEPT,
    addLabel: "Add photo or video",
    replaceLabel: "Replace media",
    aspectClass: null,
  },
  tiktok: {
    mode: "single-video",
    maxCount: 1,
    allowedKinds: ["video"],
    accept: VIDEO_ONLY_ACCEPT,
    addLabel: "Add video",
    replaceLabel: "Replace video",
    aspectClass: "aspect-[9/16]",
  },
  youtube_long: {
    mode: "none",
    maxCount: 0,
    allowedKinds: [],
    accept: "",
    addLabel: "",
    replaceLabel: "",
    aspectClass: null,
  },
  youtube_shorts: {
    mode: "none",
    maxCount: 0,
    allowedKinds: [],
    accept: "",
    addLabel: "",
    replaceLabel: "",
    aspectClass: null,
  },
  youtube_community: {
    // YT Community supports text + image posts (up to 4 photos in a
    // multi-image post on web; mobile shows a single hero with swipe).
    // Video is NOT supported on Community posts — those land as Shorts
    // or full uploads. The simulator carries a defensive warning when
    // a video slide slips through from a cross-post seed.
    mode: "photos-or-video",
    maxCount: 4,
    allowedKinds: ["image"],
    accept: "image/jpeg,image/png,image/gif,image/webp",
    addLabel: "Add photo",
    replaceLabel: "Replace photo",
    aspectClass: null,
  },
  newsletter: {
    mode: "none",
    maxCount: 0,
    allowedKinds: [],
    accept: "",
    addLabel: "",
    replaceLabel: "",
    aspectClass: null,
  },
  threads: {
    mode: "none",
    maxCount: 0,
    allowedKinds: [],
    accept: "",
    addLabel: "",
    replaceLabel: "",
    aspectClass: null,
  },
};

/** Cheap wrapper — null-safe lookup that handles the "post type not yet set"
 *  shape (returns `none`-flavored defaults so callers can branch on `mode`
 *  without nullable juggling). */
export function getMediaRule(postType: string | null): PlatformMediaRule {
  if (!postType || !(postType in PLATFORM_MEDIA_RULES)) {
    return PLATFORM_MEDIA_RULES.youtube_long; // any `mode: "none"` row works
  }
  return PLATFORM_MEDIA_RULES[postType as PostType];
}

/** True for post types whose primary asset is a video. Used by the
 *  repost / cross-post route to decide whether a missing source archive
 *  should trigger `enrichSingleItem({ withMedia: true, force: true })`. */
export function isVideoBearingPostType(postType: string | null): boolean {
  const rule = getMediaRule(postType);
  return rule.mode !== "none" && rule.allowedKinds.includes("video");
}

/** True for single-media modes (single-video, single-any). */
export function isSingleMediaMode(mode: MediaMode): boolean {
  return mode === "single-video" || mode === "single-any";
}
