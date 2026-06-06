"use client";

import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import { DraftMediaDropZone } from "../draft-media-dropzone";
import { MultiSlideCarousel } from "../multi-slide-carousel";
import { PLATFORM_MEDIA_RULES } from "@/lib/platform-media-rules";

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
    // Container query (not a viewport breakpoint): the preview lives in a
    // narrow pane (the Details tab is two-column and the whole app is often
    // split-screen), so a viewport `sm:` would force the media+caption side by
    // side even when the pane is tiny — squeezing the caption to ~1 char per
    // line. Only go side-by-side once the PANE itself is wide enough to give
    // the caption a readable column; otherwise stack (media on top).
    <div className="@container">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 @[40rem]:flex-row @[40rem]:items-start">
      {/* LEFT: 1:1 carousel — drop in up to 10 photos/videos. The dropzone
       *  handles uploads/deletes per slide; `MultiSlideCarousel` handles
       *  snap-scroll, dots, count badge, and per-slide overlays.
       *  `sm:items-start` on the parent prevents the right-column caption
       *  (which can run hundreds of lines on a Canva-generated draft)
       *  from flex-stretching this square carousel into a tall portrait
       *  letterbox. Without it `aspect-square` gets overridden and the
       *  4-slide images sit in massive black bars. */}
      <div
        className={`relative ${PLATFORM_MEDIA_RULES.instagram_post.aspectClass} w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black`}
      >
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
    </div>
  );
}
