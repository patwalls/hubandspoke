// What the nav's New menu can make, beyond the newsletter (which has its own
// dialog). Shared by the menu (client) and the create route (server), so
// both agree on a kind's post type and which editor it opens in.
import type { PostType } from "@/lib/platform-field-schemas";

export const NEW_POST_KINDS = [
  { key: "instagram_post", label: "Instagram post", platform: "instagram", postType: "instagram_post" },
  { key: "instagram_reel", label: "Instagram reel", platform: "instagram", postType: "instagram_reel" },
  { key: "youtube_short", label: "YouTube Short", platform: "youtube", postType: "youtube_shorts" },
  { key: "youtube_community", label: "YouTube community post", platform: "youtube", postType: "youtube_community" },
  { key: "x_post", label: "X / Twitter post", platform: "x", postType: "x" },
  { key: "linkedin_post", label: "LinkedIn post", platform: "linkedin", postType: "linkedin" },
] as const satisfies readonly { key: string; label: string; platform: string; postType: PostType }[];

export type NewPostKind = (typeof NEW_POST_KINDS)[number]["key"];

export function newPostKind(key: string): (typeof NEW_POST_KINDS)[number] | null {
  return NEW_POST_KINDS.find((k) => k.key === key) ?? null;
}

/** Vertical video: always cut in the clip editor. */
const SHORT_POST_TYPES: ReadonlySet<string> = new Set(["instagram_reel", "youtube_shorts"]);

/**
 * Where a new post opens:
 *  - `design` — the design editor, for an Instagram post whose format has a
 *    design template;
 *  - `clip` — the clip editor, for a reel or Short, and for an X post whose
 *    format posts video (formatsForClipPosts);
 *  - `post` — the post's own page, where the Draft Algorithm writes the copy.
 * An editor the user doesn't have the flag for falls through to `post`.
 */
export function editorForNewPost(args: {
  postType: string;
  hasDesignTemplate: boolean;
  isXVideoFormat: boolean;
  flags: { designEditor: boolean; clipEditor: boolean };
}): "design" | "clip" | "post" {
  if (args.flags.designEditor && args.postType === "instagram_post" && args.hasDesignTemplate) return "design";
  if (args.flags.clipEditor && (SHORT_POST_TYPES.has(args.postType) || (args.postType === "x" && args.isXVideoFormat))) return "clip";
  return "post";
}

export function isShortPostType(postType: string): boolean {
  return SHORT_POST_TYPES.has(postType);
}
