import type { ContentDraftContent } from "@/lib/db/schema";
import type { ProductionItem } from "@/types";
import type { EnrichmentMedia } from "../enrichment-dialog";
import {
  PLATFORM_FIELD_SCHEMAS,
  type PlatformKey,
} from "@/lib/platform-field-schemas";

export type PreviewSlide = {
  url: string | null;
  kind: "image" | "video";
  posterUrl: string | null;
};

export type PreviewData = {
  author: {
    handle: string | null;
    displayName: string | null;
    followerCount: number | null;
    verified: boolean;
    avatarUrl: string | null;
  };
  caption: string;
  secondaryText: string | null;
  slides: PreviewSlide[];
  publishedLink: string | null;
  publishedAt: string | null;
};

// Which draft field feeds which role per platform. Order matters for
// components that render multiple editable fields (e.g. YouTube title +
// description) — the platform simulator decides which to show where.
export type PlatformFieldMap = {
  caption: string | null;
  secondary: string | null;
};

export const PLATFORM_FIELD_MAP: Record<PlatformKey, PlatformFieldMap> = {
  x: { caption: "tweet", secondary: null },
  instagram_reel: { caption: "caption", secondary: "hook" },
  instagram_post: { caption: "caption", secondary: null },
  instagram_story: { caption: "caption", secondary: null },
  youtube_long: { caption: "description", secondary: "title" },
  youtube_shorts: { caption: "description", secondary: "title" },
  linkedin: { caption: "body", secondary: null },
  newsletter: { caption: "body", secondary: "subject" },
  tiktok: { caption: "caption", secondary: null },
  threads: { caption: "post", secondary: null },
};

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractDraftSlides(value: unknown): PreviewSlide[] | null {
  if (!Array.isArray(value)) return null;
  const slides: PreviewSlide[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const imageUrl = (raw as { imageUrl?: unknown }).imageUrl;
    if (typeof imageUrl !== "string" || imageUrl.length === 0) continue;
    slides.push({ url: imageUrl, kind: "image", posterUrl: null });
  }
  return slides.length > 0 ? slides : null;
}

export function resolvePreviewData(
  platform: PlatformKey,
  item: ProductionItem,
  media: EnrichmentMedia[],
  draftContent: ContentDraftContent | null,
): PreviewData {
  const fieldMap = PLATFORM_FIELD_MAP[platform];
  const schema = PLATFORM_FIELD_SCHEMAS[platform];

  const captionFromDraft =
    fieldMap.caption && draftContent
      ? pickString(draftContent[fieldMap.caption])
      : null;
  const secondaryFromDraft =
    fieldMap.secondary && draftContent
      ? pickString(draftContent[fieldMap.secondary])
      : null;

  const caption =
    captionFromDraft ?? pickString(item.contentBody) ?? "";

  // Fall back to item.title for anything title-shaped (YouTube, newsletter
  // subject) when there's no draft yet.
  const secondary =
    secondaryFromDraft ??
    (fieldMap.secondary ? pickString(item.title) : null);

  // Slide resolution: explicit draft slides (if any field in the schema is
  // typed "slides"), then archived carousel media, then the cover image.
  let slides: PreviewSlide[] = [];
  const slideField = schema.fields.find((f) => f.type === "slides");
  if (slideField && draftContent) {
    const fromDraft = extractDraftSlides(draftContent[slideField.key]);
    if (fromDraft) slides = fromDraft;
  }
  if (slides.length === 0 && media.length > 0) {
    slides = media.map((m) => ({
      url: m.url,
      kind: m.kind === "video" ? "video" : "image",
      posterUrl: m.posterUrl,
    }));
  }
  if (slides.length === 0) {
    const cover = item.posterUrl ?? item.mediaUrl ?? item.thumbnail ?? null;
    if (cover) {
      slides = [
        {
          url: cover,
          kind:
            item.mediaContentType?.startsWith("video/") && !item.posterUrl
              ? "video"
              : "image",
          posterUrl: item.posterUrl ?? null,
        },
      ];
    }
  }

  return {
    author: {
      handle: item.authorHandle ?? null,
      displayName: item.authorDisplayName ?? null,
      followerCount: item.authorFollowerCount ?? null,
      verified: !!item.authorVerified,
      avatarUrl: null,
    },
    caption,
    secondaryText: secondary,
    slides,
    publishedLink: item.publishedLink ?? null,
    publishedAt: item.publishedDate ?? null,
  };
}

export function formatCompactCount(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export function authorInitials(
  displayName: string | null,
  handle: string | null,
): string {
  const source = displayName || handle || "?";
  const letters = source.replace(/[^a-zA-Z]/g, "");
  return (letters[0] || source[0] || "?").toUpperCase();
}
