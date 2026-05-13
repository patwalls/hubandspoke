"use client";

import { useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from "lucide-react";
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
                <VideoSlide
                  src={entry.slide.url}
                  posterUrl={entry.slide.posterUrl}
                  objectFit={objectFit}
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
          {/* IG-style prev / next chevrons — small white-glassy pill,
           *  always visible (Instagram web shows them this way too).
           *  Hidden when there's nowhere to scroll: no prev on slide 1,
           *  no next on the last slide. */}
          {index > 0 && (
            <button
              type="button"
              onClick={() => scrollToIndex(index - 1)}
              aria-label="Previous slide"
              className="absolute left-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/85 text-neutral-900 shadow-md transition-opacity hover:bg-white"
            >
              <ChevronLeftIcon className="h-4 w-4" />
            </button>
          )}
          {index < total - 1 && (
            <button
              type="button"
              onClick={() => scrollToIndex(index + 1)}
              aria-label="Next slide"
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/85 text-neutral-900 shadow-md transition-opacity hover:bg-white"
            >
              <ChevronRightIcon className="h-4 w-4" />
            </button>
          )}
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

/**
 * Native `<video controls>` puts the play button at the bottom-left and
 * adds a heavy chrome bar that fights with our 1:1 IG-Post aesthetic. We
 * render a centered semi-transparent play badge instead — click anywhere
 * on the video to start playback; once playing, the badge disappears and
 * the native controls take over (so the user can seek/pause).
 */
function VideoSlide({
  src,
  posterUrl,
  objectFit,
}: {
  src: string;
  posterUrl: string | null;
  objectFit: "contain" | "cover";
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [started, setStarted] = useState(false);

  return (
    <>
      <video
        ref={videoRef}
        src={src}
        poster={posterUrl ?? undefined}
        controls={started}
        playsInline
        className={`h-full w-full object-${objectFit}`}
        onPlay={() => setStarted(true)}
        // Don't hide controls on pause — once the user has started the
        // video, they expect the native scrubber to stay available.
      />
      {!started && (
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            v.play().catch(() => {
              /* autoplay rules, etc — surface via the native badge if it
               * fails; user can retry by clicking the native control once
               * controls are rendered. */
            });
          }}
          aria-label="Play video"
          className="absolute inset-0 m-auto h-14 w-14 rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-transform hover:scale-105 hover:bg-black/65 inline-flex items-center justify-center"
        >
          <PlayIcon className="h-7 w-7 translate-x-[2px] fill-white" />
        </button>
      )}
    </>
  );
}
