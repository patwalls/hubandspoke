import { shouldEstimate } from "@/lib/services/view-estimator";

/**
 * The one-line caption under the Views number on a live post's page.
 *
 * Views on LinkedIn, Threads, Instagram photo posts, Facebook posts and
 * YouTube community posts are never reported by the platform — we estimate
 * them from likes (`view-estimator.ts`). A post with no likes yet has no
 * estimate, so its Views tile is blank; it used to say "Reported" anyway,
 * which read like the platform had reported nothing (a broken sync) when
 * the post simply has no likes to estimate from.
 */
const PLATFORM_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  threads: "Threads",
  instagram_post: "Instagram",
  facebook_post: "Facebook",
  youtube_community: "YouTube",
};

export function viewsCaption(input: {
  postType: string | null | undefined;
  views: number | null | undefined;
  viewsEstimated: boolean | null | undefined;
  likes: number | null | undefined;
  synced: boolean;
}): string {
  const { postType, views, viewsEstimated, likes, synced } = input;
  if (views != null) return viewsEstimated ? "Estimated from likes" : "Reported";
  if (!synced) return "Not synced yet";
  if (shouldEstimate(postType)) {
    const platform = PLATFORM_LABEL[postType ?? ""] ?? "This platform";
    return likes != null && likes > 0
      ? `${platform} doesn't report views · estimate on next sync`
      : `${platform} doesn't report views · estimated once it has likes`;
  }
  return "Not reported yet";
}
