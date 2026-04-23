import type { PlatformKey } from "@/lib/platform-field-schemas";

// Font stacks picked to match each platform's real embed typography on macOS
// / iOS / Windows without shipping webfonts. Instagram Sans and Chirp aren't
// available as system fonts; we fall back to the closest native equivalent.
const FONT_INSTAGRAM =
  '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, sans-serif';
const FONT_X =
  '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_YOUTUBE =
  'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_LINKEDIN =
  '-apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_SERIF =
  'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif';

export const PLATFORM_FONT: Record<PlatformKey, string> = {
  x: FONT_X,
  threads: FONT_INSTAGRAM,
  instagram_post: FONT_INSTAGRAM,
  instagram_reel: FONT_INSTAGRAM,
  instagram_story: FONT_INSTAGRAM,
  youtube_long: FONT_YOUTUBE,
  youtube_shorts: FONT_YOUTUBE,
  youtube_community: FONT_YOUTUBE,
  tiktok: FONT_INSTAGRAM,
  linkedin: FONT_LINKEDIN,
  newsletter: FONT_SERIF,
};
