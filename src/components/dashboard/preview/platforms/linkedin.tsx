"use client";

import { ImagePlusIcon } from "lucide-react";
import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";

/**
 * Minimalist LinkedIn simulator.
 *
 * LinkedIn is text-primary. Media is optional (≤9 images OR 1 video, see
 * `validateMediaForPostType`). Layout:
 *   - Always: editable post body on the right side, with an Add-photo-or-
 *     video button below it. The button stays visible whether or not the
 *     post has media yet — the previous version conditionally rendered the
 *     dropzone, leaving editors with no way to attach a photo on a
 *     post-without-media (catch-22).
 *   - When there IS media: a media preview on the left (16:9 for video,
 *     1:1 for image), with the standard hover-overlay for download / copy.
 *
 * No "CAPTION" label — LinkedIn calls it a post body. The placeholder text
 * carries the affordance.
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
  const firstSlide = slides[0];
  // 16:9 for video (matches the LI feed); 1:1 for image since LI POV photos
  // tend to be square or portrait.
  const aspectClass =
    firstSlide?.kind === "video" ? "aspect-video" : "aspect-square";

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
        const enriched = enrichedSlides[0];
        const placeholder = placeholders[0];
        return (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
            {hasMedia && (
              <div
                className={`group relative ${aspectClass} w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black`}
              >
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
                ) : placeholder ? (
                  <div className="absolute inset-0">
                    <PlaceholderSlideRender placeholder={placeholder} />
                  </div>
                ) : null}
                {enriched?.removeButton}
              </div>
            )}

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <CaptionPanel
                itemId={itemId}
                fieldKey={fieldMap.caption}
                value={body}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                placeholder="What do you want to talk about?"
              />

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
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}
