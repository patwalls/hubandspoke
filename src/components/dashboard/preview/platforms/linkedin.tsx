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
import { CtaCard } from "../cta-card";

/**
 * LinkedIn simulator.
 *
 * LinkedIn is text-primary. The real LI feed renders body text full width,
 * with media (when present) directly below — never beside the body. Earlier
 * iterations of this simulator used a side-by-side layout that collapsed
 * the body to a ~80px gutter when the preview card was narrow, and the
 * shape didn't match what actually publishes either way. So we stack:
 *
 *   header → body (full width) → media (full width, real aspect) → add
 *
 * Media: optional, ≤9 images OR 1 video (see `validateMediaForPostType`).
 * Aspect is whatever the original is — LI happily takes portrait, landscape,
 * or square. We use `object-contain` and a `max-h` cap so a very tall
 * portrait doesn't push the page height; the simulator should look like
 * the post, not crop it.
 *
 * Field schema: `body` (longtext, ≤3000 chars). See
 * `platform-field-schemas.ts` for the agent's per-field directive.
 */
export function LinkedInSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
}: SimulatorProps) {
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  const slides = data.slides;
  const hasMedia = slides.length > 0;
  // CTA gate — see x.tsx for the rationale on why this checks live
  // content rather than the static field map.
  const ctaKey = fieldMap.cta;
  const showCta = !!ctaKey && !!liveContent && ctaKey in liveContent;
  const ctaValue = ctaKey ? readLive(liveContent, ctaKey, "") : "";

  return (
    <DraftMediaDropZone
      itemId={itemId}
      postType="linkedin"
      editable={editable}
      slides={slides}
      onMediaMutated={onMediaMutated}
      hideDefaultAddButton
    >
      {({ slides: enrichedSlides, placeholders, openPicker, canAddMore }) => {
        const totalSlides = enrichedSlides.length + placeholders.length;
        // Single-slide path renders inline so we can let `object-contain`
        // size the wrapper to the media's real aspect — `aspect-square`
        // would crop a portrait image. The shared carousel needs a
        // fixed-aspect wrapper to scroll cleanly, so we only use it when
        // there are 2+ slides (LinkedIn allows up to 9 images).
        const enriched = enrichedSlides[0];
        const placeholder = placeholders[0];
        return (
          <div className="mx-auto flex w-full max-w-[560px] flex-col gap-3">
            <SocialEmbedHeader
              name={data.author.displayName ?? data.author.handle ?? "You"}
              subtitle={data.author.bio}
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
              value={body}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              placeholder="What do you want to talk about?"
            />

            {hasMedia && totalSlides > 1 ? (
              <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-black">
                <MultiSlideCarousel
                  enrichedSlides={enrichedSlides}
                  placeholders={placeholders}
                  objectFit="contain"
                  emptyState="Drop photos to add"
                />
              </div>
            ) : hasMedia ? (
              <div className="group relative w-full overflow-hidden rounded-lg border border-border bg-black">
                {enriched?.slide.kind === "video" && enriched.slide.url ? (
                  <>
                    <video
                      src={enriched.slide.url}
                      poster={enriched.slide.posterUrl ?? undefined}
                      controls
                      playsInline
                      className="block h-auto max-h-[560px] w-full"
                    />
                    <MediaActions src={enriched.slide.url} kind="video" />
                  </>
                ) : enriched?.slide.url ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={enriched.slide.url}
                      alt=""
                      className="block h-auto max-h-[560px] w-full object-contain"
                    />
                    <MediaActions src={enriched.slide.url} />
                  </>
                ) : placeholder ? (
                  <div className="aspect-square w-full">
                    <PlaceholderSlideRender placeholder={placeholder} />
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
                {hasMedia ? "Add more media" : "Add photo or video"}
              </button>
            )}

            {showCta && ctaKey && (
              <CtaCard
                variant="linkedin"
                fieldKey={ctaKey}
                value={ctaValue}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                author={data.author}
                maxLength={1250}
              />
            )}
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}
