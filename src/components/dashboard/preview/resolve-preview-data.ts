import type { ContentDraftContent } from "@/lib/db/schema";
import type { ProductionItem } from "@/types";
import type { EnrichmentMedia } from "../enrichment-dialog";
import {
  PLATFORM_FIELD_MAP,
  PLATFORM_FIELD_SCHEMAS,
  type PlatformFieldMap,
  type PlatformKey,
} from "@/lib/platform-field-schemas";

// Re-exported here for the consumers that have always imported the field
// map alongside `PreviewSlide` / `PreviewData`. Canonical home is
// `@/lib/platform-field-schemas` so services (repost-seed) can use it
// without pulling on UI modules.
export { PLATFORM_FIELD_MAP };
export type { PlatformFieldMap };

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
    /** Free-text bio / headline. LinkedIn shows this as the editor's
     *  subtitle ("Founder, Starter Story"), X uses it as the post-author
     *  bio under the display name. Null when the account has none. */
    bio: string | null;
  };
  caption: string;
  secondaryText: string | null;
  /** Tertiary text slot — used by newsletter for the inbox preheader
   *  (`preview_text` in the v3 schema). Null on platforms that don't
   *  have a third editable text field. Falls back to
   *  `item.newsletterPreviewText` when no draft has been opened yet, so
   *  Klaviyo-synced newsletters surface the preheader the enricher
   *  pulled. */
  previewText: string | null;
  slides: PreviewSlide[];
  publishedLink: string | null;
  publishedAt: string | null;
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

  // For clip-promoted items `item.contentBody` holds the clip-idea metadata
  // (the "Source: … / Timestamp: … / Angle: … / Why: …" block written by
  // `buildContentBody` in promote-clip-idea.ts) — useful as editor context,
  // but it is *not* a caption. Surfacing it in the simulator's caption slot
  // mislabels the AI's job and confuses editors who expect to see (or
  // generate) a real caption. Skip the fallback for clips so the slot is
  // empty until a draft / AI-generated caption lands.
  const caption =
    captionFromDraft ??
    (item.sourceClipIdeaId != null
      ? ""
      : pickString(item.contentBody) ?? "");

  // Fall back to item.title for anything title-shaped (YouTube, newsletter
  // subject) when there's no draft yet.
  const secondary =
    secondaryFromDraft ??
    (fieldMap.secondary ? pickString(item.title) : null);

  // Newsletter-only tertiary slot: the inbox preheader (preview_text in
  // the v3 schema). Reads draft first, then falls back to the column the
  // Klaviyo enricher writes. Other platforms always get null here.
  const previewTextFromDraft =
    draftContent && typeof draftContent.preview_text === "string"
      ? pickString(draftContent.preview_text)
      : null;
  const previewText =
    platform === "newsletter"
      ? previewTextFromDraft ?? pickString(item.newsletterPreviewText ?? null)
      : null;

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
    const isVideo = item.mediaContentType?.startsWith("video/") ?? false;
    // For video items prefer the playable mediaUrl and use the poster as
    // the thumbnail. Earlier logic only flipped to "video" when posterUrl
    // was absent, which silently downgraded any item with both archived
    // (the common Reel case) into a static still.
    const url = isVideo
      ? item.mediaUrl ?? item.posterUrl ?? item.thumbnail ?? null
      : item.posterUrl ?? item.mediaUrl ?? item.thumbnail ?? null;
    if (url) {
      slides = [
        {
          url,
          kind: isVideo ? "video" : "image",
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
        bio: account.bio ?? null,
      }
    : {
        handle: item.authorHandle ?? null,
        displayName: item.authorDisplayName ?? null,
        followerCount: item.authorFollowerCount ?? null,
        verified: !!item.authorVerified,
        avatarUrl: null,
        bio: null,
      };

  return {
    author,
    caption,
    secondaryText: secondary,
    previewText,
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
