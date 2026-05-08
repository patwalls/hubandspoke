"use client";

import { ImagePlusIcon } from "lucide-react";
import { CaptionPanel } from "../caption-panel";
import { SocialEmbedHeader } from "../social-embed-header";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";
import { MultiSlideCarousel } from "../multi-slide-carousel";

/**
 * X simulator.
 *
 * X is text-primary. The real x.com feed renders the tweet body full
 * width, with media (when present) directly below — never beside the body.
 * Earlier iterations sat the media on the left at `max-w-[400px]`, which
 * collapsed the tweet to ~150px in the half-width preview card. Same
 * structural bug as the LinkedIn one — fixed the same way: stack.
 *
 *   header → tweet body (full width) → media (full width, 16:9 max) → add
 *
 * Media constraint: ≤4 photos OR 1 video (see `validateMediaForPostType`).
 * 4-photo composition gets the shared carousel; single photo or video
 * renders inline at 16:9.
 */
export function XSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const slides = data.slides;
  const hasMedia = slides.length > 0;

  return (
    <DraftMediaDropZone
      itemId={itemId}
      postType="x"
      editable={editable}
      slides={slides}
      onMediaMutated={onMediaMutated}
      hideDefaultAddButton
    >
      {({ slides: enrichedSlides, placeholders, openPicker, canAddMore }) => {
        const enriched = enrichedSlides[0];
        const totalSlides = enrichedSlides.length + placeholders.length;
        return (
          <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3">
            <SocialEmbedHeader
              // X convention: bold display name, then `@handle` as the
              // subtitle (or the bio when set, but the handle is the
              // canonical second line on x.com).
              name={data.author.displayName ?? data.author.handle ?? "You"}
              subtitle={
                data.author.handle ? `@${data.author.handle}` : null
              }
              avatarUrl={data.author.avatarUrl}
              verified={data.author.verified}
              monogramSeed={{
                displayName: data.author.displayName,
                handle: data.author.handle,
              }}
            />

            <CaptionPanel
              itemId={itemId}
              fieldKey={fieldMap.caption}
              value={caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              placeholder="What's happening?"
            />

            {hasMedia && totalSlides > 1 ? (
              // 2–4 photos. 16:9 wrapper so all slides crop the same way
              // x.com itself shows multi-photo as a 2/3/4-up grid; we use
              // a swipeable carousel here as a fidelity-vs-build tradeoff.
              <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
                <MultiSlideCarousel
                  enrichedSlides={enrichedSlides}
                  placeholders={placeholders}
                  objectFit="cover"
                  emptyState="Drop photos to add"
                />
              </div>
            ) : hasMedia ? (
              <div className="group relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
                {enriched?.slide.kind === "video" && enriched.slide.url ? (
                  <>
                    <video
                      src={enriched.slide.url}
                      poster={enriched.slide.posterUrl ?? undefined}
                      controls
                      playsInline
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <MediaActions src={enriched.slide.url} kind="video" />
                  </>
                ) : enriched?.slide.url ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={enriched.slide.url}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                    <MediaActions src={enriched.slide.url} />
                  </>
                ) : placeholders[0] ? (
                  <div className="absolute inset-0">
                    <PlaceholderSlideRender placeholder={placeholders[0]} />
                  </div>
                ) : null}
                {enriched?.removeButton}
              </div>
            ) : null}

            {canAddMore && (
              <button
                type="button"
                onClick={openPicker}
                className="inline-flex items-center gap-1.5 self-start rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                <ImagePlusIcon className="h-3.5 w-3.5" />
                {hasMedia ? "Add another" : "Add photo or video"}
              </button>
            )}
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}
