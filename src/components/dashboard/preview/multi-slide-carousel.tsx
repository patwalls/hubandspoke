"use client";

import { useRef, useState } from "react";
import { PlaceholderSlideRender } from "./draft-media-dropzone";
import { MediaActions } from "./media-actions";

/**
 * Shared multi-slide carousel for preview simulators.
 *
 * Used by `instagram-post.tsx` (1:1 carousel, ≤10 slides), `linkedin.tsx`
 * (free aspect, ≤9 slides), and `x.tsx` (16:9 photo carousel, ≤4 slides).
 * Snap-scrolls horizontally; arrow keys navigate when focused; a count
 * badge ("2/4") and progress dots appear when there's more than one slide.
 *
 * Per-slide media gets the same hover overlay as single-slide views via
 * `MediaActions` (download / copy / optional edit-in-Descript). Placeholder
 * tiles cover the upload-in-flight + upload-failed states from the
 * dropzone.
 *
 * The component does NOT own the dropzone; callers wrap it in
 * `DraftMediaDropZone` and pass `enrichedSlides` + `placeholders` from the
 * dropzone's render-prop.
 */
export interface CarouselSlide {
  slide: {
    url: string | null;
    kind: "image" | "video";
    posterUrl: string | null;
  };
  removeButton: React.ReactNode | null;
}

export interface CarouselPlaceholder {
  id: string;
  kind: "image" | "video";
  state: "uploading" | "error";
}

export function MultiSlideCarousel({
  enrichedSlides,
  placeholders,
  objectFit = "contain",
  emptyState = "Drop photos or videos to add",
  descriptProjectUrl,
}: {
  enrichedSlides: CarouselSlide[];
  placeholders: CarouselPlaceholder[];
  /** "contain" preserves the original aspect (good when the wrapper itself
   *  doesn't lock an aspect — LinkedIn). "cover" crops to fill the wrapper
   *  (good when the wrapper enforces 1:1 / 16:9 — IG Post, X). */
  objectFit?: "contain" | "cover";
  /** Empty-state message rendered when there are zero slides + placeholders.
   *  Phrased per platform — IG says "photos or videos", X says "photos". */
  emptyState?: string;
  /** When set, video slides get an "Edit in Descript" button in the hover
   *  overlay. IG Reel does this for clip-derived videos; pass `null` for
   *  platforms where there's no Descript composition behind the video. */
  descriptProjectUrl?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const total = enrichedSlides.length + placeholders.length;

  function scrollToIndex(i: number) {
    const el = scrollerRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(total - 1, i));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
  }

  if (total === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-white/60">
        {emptyState}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={scrollerRef}
        tabIndex={total > 1 ? 0 : -1}
        onKeyDown={(e) => {
          if (total <= 1) return;
          if (e.key === "ArrowRight") {
            e.preventDefault();
            scrollToIndex(index + 1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            scrollToIndex(index - 1);
          }
        }}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] focus:outline-none [&::-webkit-scrollbar]:hidden"
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
                  className={`h-full w-full object-${objectFit}`}
                />
                <MediaActions
                  src={entry.slide.url}
                  kind="video"
                  editUrl={descriptProjectUrl}
                />
              </>
            ) : entry.slide.url ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={entry.slide.url}
                  alt=""
                  className={`h-full w-full object-${objectFit}`}
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
          <div className="absolute inset-x-0 bottom-2 flex items-center justify-center gap-1">
            {Array.from({ length: total }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => scrollToIndex(i)}
                aria-label={`Go to slide ${i + 1}`}
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
