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
 * Minimalist TikTok simulator.
 *
 * TikTok is video-primary in a 9:16 frame, so the layout shape mirrors IG
 * Reel: video on the left, editable caption on the right. We DON'T use
 * the ig-embed CaptionPanel variant — TikTok isn't Instagram and its
 * brand isn't ours to mock.
 *
 * Add-video button lives BELOW the caption (outside the aspect-box's
 * `overflow-hidden`), mirroring LinkedIn / X. The dropzone's auto-rendered
 * Add button would otherwise be clipped.
 *
 * Field schema: `caption` (longtext, ≤2200 chars).
 */
export function TikTokSimulator({
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
  const hasMedia = data.slides.length > 0;

  return (
    <DraftMediaDropZone
      itemId={itemId}
      postType="tiktok"
      editable={editable}
      slides={data.slides}
      onMediaMutated={onMediaMutated}
      hideDefaultAddButton
    >
      {({ slides: enrichedSlides, placeholders, openPicker, canAddMore }) => {
        const enriched = enrichedSlides[0];
        const placeholder = placeholders[0];
        return (
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
            <div className="group relative aspect-[9/16] w-full max-w-[320px] shrink-0 overflow-hidden rounded-lg bg-black">
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
              ) : (
                <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/60">
                  Drop a video to add
                </div>
              )}
              {enriched?.removeButton}
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <CaptionPanel
                itemId={itemId}
                fieldKey={fieldMap.caption}
                value={caption}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                placeholder="Add a caption…"
              />

              {canAddMore && (
                <button
                  type="button"
                  onClick={openPicker}
                  className="inline-flex items-center gap-1.5 self-start rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  <ImagePlusIcon className="h-3.5 w-3.5" />
                  {hasMedia ? "Replace video" : "Add video"}
                </button>
              )}
            </div>
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}
