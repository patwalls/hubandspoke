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
  // Set when the slide came from a `production_item_media` row, so the
  // drafting surface can target it for delete. Null for fallback slides
  // (cover image, draft-stored slide objects).
  mediaId?: string | null;
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
  youtube_community: { caption: "body", secondary: null },
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
      mediaId: m.id ?? null,
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

  // Author is account-driven: when the joined `item.account` is present,
  // the simulator follows the account (so changing accountId in the header
  // updates the card without needing a republish). Snapshot columns are a
  // fallback for legacy rows where `item.account` is null.
  const account = item.account;
  const author = account
    ? {
        handle: account.handle,
        displayName: account.displayName,
        followerCount: account.followerCount ?? null,
        verified: account.verified ?? false,
        avatarUrl: account.avatarUrl,
      }
    : {
        handle: item.authorHandle ?? null,
        displayName: item.authorDisplayName ?? null,
        followerCount: item.authorFollowerCount ?? null,
        verified: !!item.authorVerified,
        avatarUrl: null,
      };

  return {
    author,
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

// Feed-style relative time: "now", "5m", "2h", "3d", "1w", then absolute date.
// Matches how Threads / X / IG render the `·` timestamp next to the handle —
// no "ago" suffix, single letter unit.
export function formatFeedTime(iso: string | null): string {
  if (!iso) return "now";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "now";
  const diff = Date.now() - then;
  if (diff < 60_000) return "now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function authorInitials(
  displayName: string | null,
  handle: string | null,
): string {
  const source = displayName || handle || "?";
  const letters = source.replace(/[^a-zA-Z]/g, "");
  return (letters[0] || source[0] || "?").toUpperCase();
}
