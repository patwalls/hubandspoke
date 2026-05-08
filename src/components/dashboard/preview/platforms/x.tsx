"use client";

import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";

/**
 * Minimalist X simulator. Twitter-card chrome (avatar / handle / engagement
 * rail) added noise without helping the editor iterate on the post copy —
 * the team only ever stares at the caption text. Layout mirrors IG Reel
 * and IG Post: optional media on the left, caption panel on the right.
 * X has no required media, so when there are no slides the caption fills
 * the row.
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
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {hasMedia && (
        <div className="relative aspect-video w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black">
          <DraftMediaDropZone
            itemId={itemId}
            postType="x"
            editable={editable}
            slides={slides}
            onMediaMutated={onMediaMutated}
          >
            {({ slides: enrichedSlides, placeholders }) => {
              const total = enrichedSlides.length + placeholders.length;
              if (total === 0) return null;
              return (
                <div className="grid h-full w-full grid-cols-1 gap-0.5">
                  {enrichedSlides.slice(0, 1).map((entry, i) => {
                    const { slide, removeButton } = entry;
                    return (
                      <div
                        key={slide.mediaId ?? `slide-${i}`}
                        className="group relative h-full w-full bg-black"
                      >
                        {removeButton}
                        {slide.kind === "video" ? (
                          <video
                            src={slide.url ?? undefined}
                            poster={slide.posterUrl ?? undefined}
                            controls
                            playsInline
                            className="h-full w-full object-cover"
                          />
                        ) : slide.url ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={slide.url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                            <MediaActions src={slide.url} />
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                  {enrichedSlides.length === 0 &&
                    placeholders.slice(0, 1).map((p) => (
                      <div key={p.id} className="relative h-full w-full">
                        <PlaceholderSlideRender placeholder={p} />
                      </div>
                    ))}
                </div>
              );
            }}
          </DraftMediaDropZone>
        </div>
      )}

      <CaptionPanel
        itemId={itemId}
        fieldKey={fieldMap.caption}
        value={caption}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
      />
    </div>
  );
}
