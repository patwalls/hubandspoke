"use client";

import { ImagePlusIcon } from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import { formatFeedTime } from "../resolve-preview-data";
import { PLATFORM_FONT } from "../platform-tokens";
import { CtaCard } from "../cta-card";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";
import { MultiSlideCarousel } from "../multi-slide-carousel";

// YouTube Community posts are text-first cards on the channel's Community
// tab. Layout mirrors the real feed: channel row on top, body text below,
// optional image attachment (1 hero or up to 4 swipeable photos), thumbs
// up/down + comment action row.
//
// Media policy lives in `platform-media-rules.ts` — up to 4 photos, no
// video. The dropzone + validator + accept-mime are all driven from
// there, so changing the cap only needs that file.

export function YouTubeCommunitySimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
  onDraftMutated,
}: SimulatorProps) {
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  const displayName = data.author.displayName ?? data.author.handle ?? "Channel";
  const slides = data.slides;
  const hasMedia = slides.length > 0;
  const time = formatFeedTime(data.publishedAt);
  // CTA gate — see x.tsx for the rationale. CTA is part of the YouTube
  // Community post shape; always render when the platform has a cta slot.
  const ctaKey = fieldMap.cta;
  const showCta = !!ctaKey;
  const ctaValue = ctaKey ? readLive(liveContent, ctaKey, "") : "";

  return (
    <DraftMediaDropZone
      itemId={itemId}
      postType="youtube_community"
      editable={editable}
      slides={slides}
      onMediaMutated={onMediaMutated}
      hideDefaultAddButton
    >
      {({ slides: enrichedSlides, placeholders, openPicker, canAddMore }) => {
        const enriched = enrichedSlides[0];
        const totalSlides = enrichedSlides.length + placeholders.length;
        // Render the media slot whenever a slide OR an in-flight upload
        // exists — placeholders should be visible during first upload.
        const showMediaSlot = hasMedia || placeholders.length > 0;
        return (
          <div
            className="mx-auto w-full max-w-[640px] rounded-xl border border-[#e5e5e5] bg-white px-4 py-4 text-[#0f0f0f]"
            style={{ fontFamily: PLATFORM_FONT.youtube_community }}
          >
            <div className="flex items-center gap-3">
              <MonogramAvatar
                displayName={data.author.displayName}
                handle={data.author.handle}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium leading-tight text-[#0f0f0f]">
                  {displayName}
                </div>
                <div className="mt-0.5 text-[12px] leading-tight text-[#606060]">
                  {time}
                </div>
              </div>
            </div>

            <div className="mt-3 whitespace-pre-wrap text-[14px] leading-[1.45] text-[#0f0f0f]">
              <EditableField
                fieldKey={fieldMap.caption}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                value={body}
                placeholder="Write a post for the Community tab…"
                multiline
                className="text-[14px] leading-[1.45]"
              />
            </div>

            {showMediaSlot && totalSlides > 1 ? (
              // 2-4 photos. Multi-image Community posts swipe horizontally
              // on web/mobile; the shared carousel mirrors that shape. We
              // bias to 16:9 (YT's house aspect) so photos crop the same
              // way across slides.
              <div className="relative mt-3 aspect-video w-full overflow-hidden rounded-[12px] border border-[#e5e5e5] bg-[#f2f2f2]">
                <MultiSlideCarousel
                  enrichedSlides={enrichedSlides}
                  placeholders={placeholders}
                  objectFit="cover"
                  emptyState="Drop photos to add"
                />
              </div>
            ) : showMediaSlot ? (
              // Single image - keep the freeform `max-h-[520px]` look the
              // existing simulator used, so a tall portrait crop still
              // renders the way YT's feed does.
              enriched?.slide.kind === "video" ? (
                // Defense in depth: even though `platform-media-rules`
                // rejects video uploads for youtube_community at the
                // validator level, a video could still slip through
                // historical cross-post seeding. Surface it so the editor
                // knows to swap before publish.
                <div className="mt-3 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900">
                  Community posts don&rsquo;t support video. Drop an image
                  instead, or publish this clip as a Short.
                </div>
              ) : enriched?.slide.url ? (
                <div className="group relative mt-3 overflow-hidden rounded-[12px] bg-[#f2f2f2]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enriched.slide.url}
                    alt=""
                    className="block h-auto max-h-[520px] w-full object-cover"
                  />
                  <MediaActions src={enriched.slide.url} />
                  {enriched.removeButton}
                </div>
              ) : placeholders[0] ? (
                <div className="relative mt-3 aspect-video w-full overflow-hidden rounded-[12px] bg-[#f2f2f2]">
                  <PlaceholderSlideRender placeholder={placeholders[0]} />
                </div>
              ) : null
            ) : null}

            {canAddMore && (
              <button
                type="button"
                onClick={openPicker}
                className="mt-3 inline-flex items-center gap-1.5 self-start rounded-md border border-dashed border-[#e5e5e5] px-2.5 py-1.5 text-[12px] font-medium text-[#606060] transition-colors hover:bg-[#f9f9f9] hover:text-[#0f0f0f]"
              >
                <ImagePlusIcon className="h-3.5 w-3.5" />
                {hasMedia ? "Add another photo" : "Add photo"}
              </button>
            )}

            <div className="mt-3 flex items-center gap-2 text-[#606060]">
              <YTAction label="Like" icon={<ThumbsUpIcon />} />
              <YTAction label="Dislike" icon={<ThumbsDownIcon />} />
              <YTAction label="Reply" icon={<CommentIcon />} />
            </div>

            {showCta && ctaKey && (
              <div className="mt-3 -mx-4">
                <CtaCard
                  variant="youtube_community"
                  fieldKey={ctaKey}
                  value={ctaValue}
                  editable={editable}
                  onLocalEdit={onLocalEdit}
                  onCommit={onCommit}
                  author={data.author}
                  maxLength={10000}
                  itemId={itemId}
                  onRegenerated={onDraftMutated}
                />
              </div>
            )}
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}

function YTAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span
      className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[#0f0f0f]"
      aria-label={label}
    >
      {icon}
    </span>
  );
}

function ThumbsUpIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M7 10v10H4V10h3Zm3-6c.83 0 1.5.67 1.5 1.5V9h5.3c.99 0 1.78.87 1.67 1.86l-.88 8A1.69 1.69 0 0 1 15.9 20H10V10l3.5-6H10Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThumbsDownIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M17 14V4h3v10h-3Zm-3 6c-.83 0-1.5-.67-1.5-1.5V15H7.2c-.99 0-1.78-.87-1.67-1.86l.88-8A1.69 1.69 0 0 1 8.1 4H14v10l-3.5 6H14Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M21 6v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
