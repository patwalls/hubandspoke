"use client";

/**
 * The design as it stands, for the Post tab's platform mock — the pages you
 * are editing right now (not the last export), one at a time with the
 * mock's arrows and dots. Video slides play with sound, captions rolling.
 * Read-only: no selection, no outlines, exactly what Export renders.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { pageVideo, type DesignDoc } from "@/lib/design-editor/doc";
import type { ChannelInfo } from "@/lib/design-editor/channel";
import type { EditorWord } from "@/lib/clip-editor/words";
import { PageCanvas, PlaybackContext, type PlaybackState } from "./page-canvas";

export function DesignPostPreview({ doc, imageUrls, videoUrl, words, channels }: {
  doc: DesignDoc;
  imageUrls: Record<string, string>;
  videoUrl: string | null;
  words: EditorWord[];
  channels: Record<string, ChannelInfo | null>;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const i = Math.min(index, doc.pages.length - 1);
  const page = doc.pages[i];
  const isVideo = !!pageVideo(page);

  const [timeSec, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [durationSec, setDuration] = useState(0);
  const playback = useMemo<PlaybackState>(() => ({ timeSec, playing, durationSec, setTime, setPlaying, setDuration, seekRequest: null, enabled: true }), [timeSec, playing, durationSec]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const go = (to: number) => {
    setPlaying(false);
    setTime(0);
    setIndex(Math.max(0, Math.min(doc.pages.length - 1, to)));
  };

  return (
    <div ref={boxRef} className="group relative w-full" style={{ aspectRatio: `${doc.canvas.width} / ${doc.canvas.height}` }}>
      {width > 0 && (
        <PlaybackContext.Provider value={playback}>
          <PageCanvas key={page.id} doc={doc} page={page} pageIndex={i} imageUrls={imageUrls} videoUrl={videoUrl} words={words} channels={channels} scale={width / doc.canvas.width} interactive={false} />
        </PlaybackContext.Provider>
      )}
      {isVideo && (
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play slide"}
          onClick={() => setPlaying(!playing)}
          className={cn("absolute inset-0 flex items-center justify-center", playing && "opacity-0 hover:opacity-100")}
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white">
            {playing ? <PauseIcon className="size-5" /> : <PlayIcon className="size-5 translate-x-px" />}
          </span>
        </button>
      )}
      {doc.pages.length > 1 && (
        <>
          <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white">{i + 1}/{doc.pages.length}</span>
          {i > 0 && (
            <button type="button" aria-label="Previous slide" onClick={() => go(i - 1)} className="absolute left-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-black shadow">
              <ChevronLeftIcon className="size-4" />
            </button>
          )}
          {i < doc.pages.length - 1 && (
            <button type="button" aria-label="Next slide" onClick={() => go(i + 1)} className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-black shadow">
              <ChevronRightIcon className="size-4" />
            </button>
          )}
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
            {doc.pages.map((p, n) => (
              <button key={p.id} type="button" aria-label={`Slide ${n + 1}`} onClick={() => go(n)} className={cn("size-1.5 rounded-full", n === i ? "bg-sky-400" : "bg-white/60")} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
