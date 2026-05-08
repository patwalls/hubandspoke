"use client";

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
 * LinkedIn is text-primary — a long-form post body with optional media —
 * so the simulator mirrors the X layout: optional media on the left
 * (16:9 for video, 1:1 for image), `CaptionPanel` minimal variant on the
 * right. The post body is the single editable field.
 *
 * No platform chrome (avatar / handle / follower count / action rail) —
 * editors only iterate on the body copy. The minimal label + textarea
 * wins over a faux LinkedIn card.
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
  // First-slide kind drives the aspect ratio: videos get 16:9 (matches the
  // LinkedIn feed), images get 1:1 because portrait images are common in
  // LinkedIn POV-style content.
  const firstSlide = slides[0];
  const aspectClass =
    firstSlide?.kind === "video"
      ? "aspect-video"
      : "aspect-square";

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {hasMedia && (
        <div
          className={`group relative ${aspectClass} w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black`}
        >
          <DraftMediaDropZone
            itemId={itemId}
            postType="linkedin"
            editable={editable}
            slides={slides}
            onMediaMutated={onMediaMutated}
          >
            {({ slides: enrichedSlides, placeholders }) => {
              const enriched = enrichedSlides[0];
              const placeholder = placeholders[0];
              return (
                <>
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
                </>
              );
            }}
          </DraftMediaDropZone>
        </div>
      )}

      <CaptionPanel
        itemId={itemId}
        fieldKey={fieldMap.caption}
        value={body}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
      />
    </div>
  );
}
