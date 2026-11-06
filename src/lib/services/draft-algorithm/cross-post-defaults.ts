// Built-in cross-post caption rules, per target post type. Used by the
// Draft Algorithm (run.ts) on the cross_post path when the format's Skill
// has no "Cross Post Rules" section — most people never write one, so the
// AI still knows the house shape for a repost. A Skill section, when
// present, replaces these entirely.
//
// The text tells the model these are DEFAULTS: the format's own notes and
// this account's consistent past cross-posts win over them.

const SHORT_FORM_VIDEO = "Keep the original caption's message and voice; adjust the length to fit the platform.";

const RULES: Record<string, string> = {
  x: "Use the clip's on-screen hook as the post body, word for word. One line. No thread, no link, no CTA.",
  threads: "Use the clip's on-screen hook as the post body, word for word. One line. No thread, no link, no CTA.",
  linkedin: "A short version of the caption: 2–3 lines, professional tone, no hashtags.",
  instagram_reel: SHORT_FORM_VIDEO,
  instagram_post: SHORT_FORM_VIDEO,
  tiktok: SHORT_FORM_VIDEO,
  youtube_shorts: SHORT_FORM_VIDEO,
  facebook_post: SHORT_FORM_VIDEO,
};

/** Default rules for a cross-post to `postType`, or null when there's no
 *  default for that surface. */
export function defaultCrossPostRules(postType: string | null | undefined): string | null {
  const rule = postType ? RULES[postType] : undefined;
  if (!rule) return null;
  return [
    "Built-in defaults (no team-written cross-post rules for this format). If the format notes above say how reposts should look, follow them instead; if this account's past cross-posts consistently do it differently, follow those.",
    `- ${rule}`,
  ].join("\n");
}
