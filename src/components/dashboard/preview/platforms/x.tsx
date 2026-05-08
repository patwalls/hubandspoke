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
 * Minimalist X simulator.
 *
 * X is text-primary. Media is optional (≤4 photos OR 1 video). Layout:
 *   - Always: editable tweet body on the right with an Add-photo-or-video
 *     button below. Button stays visible whether or not the post has media
 *     yet — the previous version conditionally rendered the dropzone,
 *     leaving editors with no way to attach a photo on a media-less tweet.
 *   - When there IS media: a 16:9 thumbnail on the left.
 *
 * No "CAPTION" label. The placeholder ("What's happening?") carries the
 * affordance.
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
        return (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
            {hasMedia && (
              <div className="group relative aspect-video w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black">
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
            )}

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <CaptionPanel
                itemId={itemId}
                fieldKey={fieldMap.caption}
                value={caption}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                placeholder="What's happening?"
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
