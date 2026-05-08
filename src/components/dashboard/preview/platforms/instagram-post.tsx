"use client";

import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import { DraftMediaDropZone } from "../draft-media-dropzone";
import { MultiSlideCarousel } from "../multi-slide-carousel";

export function InstagramPostSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
  onDraftMutated,
  descriptProjectUrl,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {/* LEFT: 1:1 carousel — drop in up to 10 photos/videos. The dropzone
       *  handles uploads/deletes per slide; `MultiSlideCarousel` handles
       *  snap-scroll, dots, count badge, and per-slide overlays. */}
      <div className="relative aspect-square w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black">
        <DraftMediaDropZone
          itemId={itemId}
          postType="instagram_post"
          editable={editable}
          slides={data.slides}
          onMediaMutated={onMediaMutated}
        >
          {({ slides: enrichedSlides, placeholders }) => (
            <MultiSlideCarousel
              enrichedSlides={enrichedSlides}
              placeholders={placeholders}
              objectFit="contain"
              emptyState="Drop photos or videos to add"
              descriptProjectUrl={descriptProjectUrl}
            />
          )}
        </DraftMediaDropZone>
      </div>

      {/* RIGHT: ig-embed-style sidebar — same layout as IG Reel. No
       *  "Original audio" subtitle since IG Posts are static. */}
      <CaptionPanel
        itemId={itemId}
        fieldKey={fieldMap.caption}
        value={caption}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        showRegenerate
        onRegenerated={onDraftMutated}
        variant="ig-embed"
        author={data.author}
        subtitle={null}
      />
    </div>
  );
}
