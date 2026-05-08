"use client";

import { useState } from "react";
import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";

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
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {/* LEFT: 1:1 carousel — drop in up to 10 photos/videos. The dropzone
       *  already handles uploading/deleting per-slide; the inner carousel
       *  is responsible for snap scrolling + per-slide chrome. */}
      <div className="relative aspect-square w-full max-w-[400px] shrink-0 overflow-hidden rounded-lg bg-black">
        <DraftMediaDropZone
          itemId={itemId}
          postType="instagram_post"
          editable={editable}
          slides={data.slides}
          onMediaMutated={onMediaMutated}
        >
          {({ slides: enrichedSlides, placeholders }) => (
            <IgPostCarousel
              enrichedSlides={enrichedSlides}
              placeholders={placeholders}
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
        publishedAt={data.publishedAt}
      />
    </div>
  );
}

/**
 * Inline IG-Post carousel that supports per-slide remove buttons and
 * placeholder tiles. Snap-scroll behavior matches the shared
 * `<SlideCarousel>` (we don't reuse it because we need per-slide overlays
 * the carousel doesn't expose).
 */
function IgPostCarousel({
  enrichedSlides,
  placeholders,
}: {
  enrichedSlides: Array<{
    slide: { url: string | null; kind: "image" | "video"; posterUrl: string | null };
    removeButton: React.ReactNode | null;
  }>;
  placeholders: Array<{ id: string; kind: "image" | "video"; state: "uploading" | "error" }>;
}) {
  const [index, setIndex] = useState(0);
  const total = enrichedSlides.length + placeholders.length;
  if (total === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/60">
        Drop photos or videos to add
      </div>
    );
  }
  return (
    <div className="relative h-full w-full">
      <div
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / el.clientWidth);
          if (i !== index) setIndex(i);
        }}
      >
        {enrichedSlides.map((entry, i) => (
          <div
            key={entry.slide.url ?? i}
            className="group relative h-full w-full shrink-0 snap-center"
          >
            {entry.removeButton}
            {entry.slide.kind === "video" && entry.slide.url ? (
              <>
                <video
                  src={entry.slide.url}
                  poster={entry.slide.posterUrl ?? undefined}
                  controls
                  playsInline
                  className="h-full w-full object-contain"
                />
                <MediaActions src={entry.slide.url} kind="video" />
              </>
            ) : entry.slide.url ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={entry.slide.url}
                  alt=""
                  className="h-full w-full object-contain"
                />
                <MediaActions src={entry.slide.url} />
              </>
            ) : null}
          </div>
        ))}
        {placeholders.map((p) => (
          <div key={p.id} className="relative h-full w-full shrink-0 snap-center">
            <PlaceholderSlideRender placeholder={p} />
          </div>
        ))}
      </div>

      {total > 1 && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums">
            {index + 1}/{total}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-1">
            {Array.from({ length: total }).map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  i === index ? "bg-white" : "bg-white/40"
                }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
