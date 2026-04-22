"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { PreviewSlide } from "./resolve-preview-data";

type Aspect = "square" | "portrait" | "portrait-45" | "video";

const ASPECT_CLASS: Record<Aspect, string> = {
  square: "aspect-square",
  // 4:5 — standard Instagram feed post
  "portrait-45": "aspect-[4/5]",
  // 9:16 — Reels / Stories / Shorts
  portrait: "aspect-[9/16]",
  video: "aspect-video",
};

// Simple horizontal snap carousel used by IG Post and Threads. Native CSS
// scroll-snap + a tiny dot indicator synced to scroll position — no swipe
// library, no transitions beyond the browser default.
//
// Images use object-contain on a black letterbox so posts designed for
// portrait ratios (common for IG carousels) don't get their hook text cropped
// off the bottom.
export function SlideCarousel({
  slides,
  aspect = "portrait-45",
  className,
}: {
  slides: PreviewSlide[];
  aspect?: Aspect;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const aspectClass = ASPECT_CLASS[aspect];

  if (slides.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-xs text-muted-foreground",
          aspectClass,
          className,
        )}
      >
        No media
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      <div
        className={cn(
          "flex w-full overflow-x-auto snap-x snap-mandatory scroll-smooth bg-black",
          aspectClass,
          "[&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
        )}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / el.clientWidth);
          if (i !== index) setIndex(i);
        }}
      >
        {slides.map((slide, i) => (
          <div
            key={i}
            className="relative h-full w-full shrink-0 snap-center"
          >
            {slide.kind === "video" ? (
              <video
                src={slide.url ?? undefined}
                poster={slide.posterUrl ?? undefined}
                controls
                playsInline
                className="h-full w-full object-contain"
              />
            ) : slide.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slide.url}
                alt=""
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                Missing media
              </div>
            )}
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <>
          <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white tabular-nums">
            {index + 1}/{slides.length}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-1">
            {slides.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  i === index ? "bg-white" : "bg-white/40",
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
