/**
 * Named groups of post types, so "short-form" / "long-form" is ONE assistant
 * search instead of one per platform. short_form matches the app's existing
 * definition (top short-form performers, hook extraction).
 */
export const POST_TYPE_GROUPS: Record<string, string[]> = {
  short_form: ["youtube_shorts", "instagram_reel", "tiktok"],
  long_form: ["youtube_long"],
  text: ["x", "linkedin", "threads"],
};

/** "short_form" → its types; "tiktok, instagram_reel" → both; "x" → ["x"]; blank → undefined. */
export function resolvePostTypes(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const key = part.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!key) continue;
    for (const t of POST_TYPE_GROUPS[key] ?? [key]) out.add(t);
  }
  return out.size ? [...out] : undefined;
}
