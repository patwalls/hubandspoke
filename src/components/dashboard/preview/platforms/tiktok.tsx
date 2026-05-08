"use client";

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
 * brand isn't ours to mock. The plain `CaptionPanel` minimal layout is
 * the right call: a CAPTION label + the editable text, nothing else.
 *
 * Field schema: `caption` (longtext, ≤2200 chars). See
 * `platform-field-schemas.ts`.
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

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      <div className="group relative aspect-[9/16] w-full max-w-[320px] shrink-0 overflow-hidden rounded-lg bg-black">
        <DraftMediaDropZone
          itemId={itemId}
          postType="tiktok"
          editable={editable}
          slides={data.slides}
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
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
                    Drop a video to add
                  </div>
                )}
                {enriched?.removeButton}
              </>
            );
          }}
        </DraftMediaDropZone>
      </div>

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
