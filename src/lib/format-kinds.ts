// What the Formats tab's "Add format" menu can make. Platform first (the
// menu rows), then Clip or Carousel / image (the dialog's Type toggle). Each kind carries every setting a new format of
// that kind needs to WORK, so the create dialog never asks the user to
// flip technical toggles: clippable, clip target, aspect, labels-as-
// original, and the post type its channel gets.
//
// Shared with the detail page (`familyForFormat`) so the guided Skill
// editor shows the same guidance for existing formats.
import type { PostType } from "@/lib/platform-field-schemas";

export type FormatFamily = "pillar" | "clip" | "design" | "newsletter";

export interface FormatKind {
  key: string;
  /** Short label on the Type toggle ("Clip", "Carousel / image"). */
  toggleLabel: string;
  /** Full name used in the dialog title ("Instagram Reel"). */
  label: string;
  family: FormatFamily;
  /** Post type written to the format's channel. */
  postType: PostType;
  /** Account platform the channel picker lists. */
  accountPlatform: string;
  isClippableFormat: boolean;
  labelsAsOriginal: boolean;
  clipTargetPostType: PostType | null;
  clipTargetPlatform: string[] | null;
  clipAspectRatio: "9:16" | "16:9" | null;
  /** Whether the dialog asks which pillar this comes from. */
  parent: "required" | "optional" | "none";
  /** Whether the view-threshold field is offered. */
  showsViewThreshold: boolean;
  /** One line naming where posts in this format get made. */
  editorLine: string;
  /** The next step on the detail page after creating. */
  nextStep: string;
  /** The editor that designs this format's look, opened by the dialog's
   *  "Next: design format" (clip look / design template). Null when posts
   *  of this kind don't go through one — e.g. the design editor only opens
   *  Instagram posts today (editorForNewPost). */
  designer: "clip" | "design" | null;
}

export interface FormatPlatform {
  key: string;
  label: string;
  /** PlatformIcon key. */
  icon: string;
  /** Shown in the menu but not pickable yet. */
  comingSoon?: boolean;
  kinds: FormatKind[];
}

const clip = (
  key: string,
  label: string,
  postType: PostType,
  accountPlatform: string,
  targetPlatform: string,
  aspect: "9:16" | "16:9",
): FormatKind => ({
  key,
  toggleLabel: "Clip",
  label,
  family: "clip",
  postType,
  accountPlatform,
  isClippableFormat: true,
  labelsAsOriginal: false,
  clipTargetPostType: postType,
  clipTargetPlatform: [targetPlatform],
  clipAspectRatio: aspect,
  parent: "required",
  showsViewThreshold: true,
  editorLine: "Cut from a pillar video, edited in the clip editor",
  nextStep: "Set up the clip look (captions, hook text, framing)",
  designer: "clip",
});

const carousel = (
  key: string,
  label: string,
  postType: PostType,
  accountPlatform: string,
  editorLine: string,
  nextStep: string,
  designer: "design" | null = null,
): FormatKind => ({
  key,
  toggleLabel: "Carousel / image",
  label,
  family: "design",
  postType,
  accountPlatform,
  isClippableFormat: false,
  labelsAsOriginal: false,
  clipTargetPostType: null,
  clipTargetPlatform: null,
  clipAspectRatio: null,
  parent: "required",
  showsViewThreshold: true,
  editorLine,
  nextStep,
  designer,
});

// The design editor only opens Instagram posts today (editorForNewPost in
// new-post-kinds.ts); carousels elsewhere are drafted on the post's page.
const WRITTEN = "Drafted by AI from the pillar video, edited on the post's page";
const WRITTEN_NEXT = "Check the Skill, then make a post from the New menu";

/** Every social platform makes both a clip and a carousel / image post. */
const social = (
  key: string,
  label: string,
  icon: string,
  o: {
    clipPostType: PostType;
    carouselPostType: PostType;
    clipTarget: string;
    aspect: "9:16" | "16:9";
    clipLabel?: string;
    carouselLabel?: string;
    carouselEditorLine?: string;
    carouselNextStep?: string;
    carouselDesigner?: "design";
  },
): FormatPlatform => ({
  key,
  label,
  icon,
  kinds: [
    clip(`${key}_clip`, o.clipLabel ?? `${label} video`, o.clipPostType, key, o.clipTarget, o.aspect),
    carousel(
      `${key}_carousel`,
      o.carouselLabel ?? `${label} carousel / image post`,
      o.carouselPostType,
      key,
      o.carouselEditorLine ?? WRITTEN,
      o.carouselNextStep ?? WRITTEN_NEXT,
      o.carouselDesigner ?? null,
    ),
  ],
});

export const FORMAT_PLATFORMS: FormatPlatform[] = [
  {
    key: "pillar",
    label: "Pillar",
    icon: "youtube",
    kinds: [
      {
        key: "pillar",
        toggleLabel: "Pillar",
        label: "Pillar (YouTube video)",
        family: "pillar",
        postType: "youtube_long",
        accountPlatform: "youtube",
        isClippableFormat: false,
        labelsAsOriginal: true,
        clipTargetPostType: null,
        clipTargetPlatform: null,
        clipAspectRatio: null,
        parent: "none",
        showsViewThreshold: false,
        editorLine: "The original long video that clips and carousel / image posts are made from",
        nextStep: "Add derivative formats (clips, carousel / image posts) under this pillar",
        designer: null,
      },
    ],
  },
  social("instagram", "Instagram", "instagram", {
    clipPostType: "instagram_reel",
    carouselPostType: "instagram_post",
    clipTarget: "Instagram Reel",
    aspect: "9:16",
    clipLabel: "Instagram Reel",
    carouselLabel: "Instagram carousel / image post",
    carouselEditorLine: "Built slide-by-slide in the design editor",
    carouselNextStep: "Set up the design template (slides, fonts, layout)",
    carouselDesigner: "design",
  }),
  social("youtube", "YouTube", "youtube", {
    clipPostType: "youtube_shorts",
    carouselPostType: "youtube_community",
    clipTarget: "YouTube Shorts",
    aspect: "9:16",
    clipLabel: "YouTube Short",
    carouselLabel: "YouTube community post",
  }),
  social("x", "X", "x", { clipPostType: "x", carouselPostType: "x", clipTarget: "X", aspect: "16:9" }),
  social("linkedin", "LinkedIn", "linkedin", {
    clipPostType: "linkedin",
    carouselPostType: "linkedin",
    clipTarget: "LinkedIn",
    aspect: "16:9",
  }),
  social("threads", "Threads", "threads", {
    clipPostType: "threads",
    carouselPostType: "threads",
    clipTarget: "Threads",
    aspect: "16:9",
  }),
  social("facebook", "Facebook", "facebook", {
    clipPostType: "facebook_post",
    carouselPostType: "facebook_post",
    clipTarget: "Facebook",
    aspect: "9:16",
  }),
  {
    key: "newsletter",
    label: "Newsletter",
    icon: "newsletter",
    // Not every brand has the newsletter drafter set up yet.
    comingSoon: true,
    kinds: [
      {
        key: "newsletter",
        toggleLabel: "Newsletter",
        label: "Newsletter",
        family: "newsletter",
        postType: "newsletter",
        accountPlatform: "newsletter",
        isClippableFormat: false,
        labelsAsOriginal: false,
        clipTargetPostType: null,
        clipTargetPlatform: null,
        clipAspectRatio: null,
        parent: "optional",
        showsViewThreshold: false,
        editorLine: "Drafted by AI in the newsletter editor",
        nextStep: "Set up the newsletter template",
        designer: null,
      },
    ],
  },
];

export function formatPlatform(key: string): FormatPlatform | null {
  return FORMAT_PLATFORMS.find((p) => p.key === key) ?? null;
}

/** The body POST /api/formats needs for a kind's fixed settings. */
export function formatKindSettings(kind: FormatKind) {
  return {
    isClippableFormat: kind.isClippableFormat,
    labelsAsOriginal: kind.labelsAsOriginal,
    clipTargetPostType: kind.clipTargetPostType,
    clipTargetPlatform: kind.clipTargetPlatform,
    clipAspectRatio: kind.clipAspectRatio,
  };
}

/** Best guess at an EXISTING format's family, for the guided Skill editor
 *  on the detail page. Clippable wins (it's what drives clip generation),
 *  then a newsletter channel, then a root original (pillar). */
export function familyForFormat(f: {
  isClippableFormat: boolean;
  labelsAsOriginal: boolean;
  parentFormatId: string | null;
  postTypes: (string | null)[];
}): FormatFamily {
  if (f.isClippableFormat) return "clip";
  if (f.postTypes.includes("newsletter")) return "newsletter";
  if (!f.parentFormatId && (f.labelsAsOriginal || f.postTypes.includes("youtube_long"))) return "pillar";
  return "design";
}

/** A human label for an existing format ("Instagram Reel"), for the AI
 *  Skill builder: the kind matching its family + first channel post type. */
export function kindLabelForFormat(family: FormatFamily, postTypes: (string | null)[]): string {
  const kinds = FORMAT_PLATFORMS.flatMap((p) => p.kinds).filter((k) => k.family === family);
  const hit = kinds.find((k) => postTypes.includes(k.postType));
  if (hit) return hit.label;
  return { clip: "video clip", design: "carousel / image post", pillar: "pillar video", newsletter: "newsletter" }[family];
}

/** The old-style platform label clip ideas carry on `production_items.platform`
 *  (and that reference hooks are matched on), per post type. */
const CLIP_PLATFORM_LABEL: Record<string, string> = {
  instagram_reel: "Instagram Reel",
  youtube_shorts: "YouTube Shorts",
  tiktok: "TikTok",
  x: "X",
  linkedin: "LinkedIn",
  threads: "Threads",
  facebook_post: "Facebook",
};

/** A clip format's `clip_target_post_type` / `clip_target_platform`, worked
 *  out from the account it posts to — so the two can never disagree with
 *  "Where it posts". Null for a post type clips don't target. */
export function clipTargetForPostType(
  postType: string | null | undefined,
): { clipTargetPostType: string; clipTargetPlatform: string[] } | null {
  const label = postType ? CLIP_PLATFORM_LABEL[postType] : undefined;
  return label ? { clipTargetPostType: postType!, clipTargetPlatform: [label] } : null;
}

/** Which menu platform + kind an EXISTING format is, so the guided dialog
 *  can open on it for editing: its family (familyForFormat) matched against
 *  its first channel's post type; falls back to the family's first kind. */
export function kindForExistingFormat(f: {
  isClippableFormat: boolean;
  labelsAsOriginal: boolean;
  parentFormatId: string | null;
  postTypes: (string | null)[];
}): { platformKey: string; kindKey: string } {
  const family = familyForFormat(f);
  const pt = f.postTypes.find(Boolean) ?? null;
  for (const p of FORMAT_PLATFORMS) {
    const k = p.kinds.find((k) => k.family === family && k.postType === pt);
    if (k) return { platformKey: p.key, kindKey: k.key };
  }
  const p = FORMAT_PLATFORMS.find((p) => p.kinds.some((k) => k.family === family)) ?? FORMAT_PLATFORMS[1];
  const k = p.kinds.find((k) => k.family === family) ?? p.kinds[0];
  return { platformKey: p.key, kindKey: k.key };
}
