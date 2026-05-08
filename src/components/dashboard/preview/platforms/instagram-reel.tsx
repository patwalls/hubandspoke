"use client";

import { useState } from "react";
import {
  AlertTriangleIcon,
  Loader2Icon,
  PlayCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { CaptionPanel } from "../caption-panel";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";
import { MediaActions } from "../media-actions";

export function InstagramReelSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onMediaMutated,
  onDraftMutated,
  descriptRenderState,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const noMedia = data.slides.length === 0;
  // Edge case: a `production_item_media` row exists but its presigned URL
  // came back null (the resolve-preview-data presigner timed out, or the
  // S3 key is missing). Falling back to the rendering placeholder beats
  // rendering an empty `<video>` tag — that's the "black box" the user
  // hit when the publish task had finished but the simulator hadn't yet
  // gotten a refreshed presign.
  const firstSlide = data.slides[0];
  const videoNotReady =
    firstSlide?.kind === "video" && !firstSlide.url;
  const showStatePlaceholder =
    (!!descriptRenderState && noMedia) ||
    (videoNotReady && !!descriptRenderState);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {/* LEFT: 9:16 video player or render-state placeholder. No overlays
       *  on the video itself — the burned-in hook text already lives in
       *  the rendered MP4, and a duplicate simulator overlay just clashes
       *  with it. */}
      <div className="relative aspect-[9/16] w-full max-w-[320px] shrink-0 overflow-hidden rounded-lg bg-black">
        {showStatePlaceholder ? (
          <ReelStatePlaceholder
            state={descriptRenderState!}
            itemId={itemId}
          />
        ) : (
          <DraftMediaDropZone
            itemId={itemId}
            postType="instagram_reel"
            editable={editable}
            slides={data.slides}
            onMediaMutated={onMediaMutated}
          >
            {({ slides: enrichedSlides, placeholders }) => {
              const enriched = enrichedSlides[0];
              const placeholder = placeholders[0];
              return (
                <>
                  {enriched?.slide.kind === "video" ? (
                    <video
                      src={enriched.slide.url ?? undefined}
                      poster={enriched.slide.posterUrl ?? undefined}
                      controls
                      playsInline
                      className="absolute inset-0 h-full w-full object-cover"
                    />
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
                      Drag a video to add
                    </div>
                  )}
                  {enriched?.removeButton}
                </>
              );
            }}
          </DraftMediaDropZone>
        )}
      </div>

      {/* RIGHT: caption only — keeps the simulator focused on the one
       *  field editors actually iterate on for Reels. */}
      <CaptionPanel
        itemId={itemId}
        fieldKey={fieldMap.caption}
        value={caption}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        showRegenerate
        onRegenerated={onDraftMutated}
      />
    </div>
  );
}

/**
 * Render-state placeholder shown inside the 9:16 frame while the MP4 is
 * rendering, awaiting render, or failed. Sub-states map to the existing
 * descript_publish_* columns; "awaiting" includes a Render now button so
 * editors can kick off a stuck render without leaving the page.
 */
function ReelStatePlaceholder({
  state,
  itemId,
}: {
  state: "rendering" | "awaiting" | "failed";
  itemId: string;
}) {
  const [retrying, setRetrying] = useState(false);

  async function handleRetry(force: boolean) {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/sync-descript-publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't start render");
        return;
      }
      toast.success("Rendering MP4 in Descript…", {
        description: "Takes ~2–10 min. The video will appear here automatically.",
      });
    } finally {
      setRetrying(false);
    }
  }

  if (state === "rendering") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80">
        <Loader2Icon className="h-7 w-7 animate-spin text-white/90" />
        <span className="text-sm font-semibold leading-tight">
          Rendering MP4 in Descript…
        </span>
        <span className="text-xs leading-snug text-white/55">
          Usually 2–10 minutes. The video will appear here automatically.
        </span>
      </div>
    );
  }
  if (state === "awaiting") {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80">
        <PlayCircleIcon className="h-9 w-9 text-white/60" strokeWidth={1.5} />
        <span className="text-sm font-semibold leading-tight">
          Awaiting render
        </span>
        <button
          type="button"
          onClick={() => void handleRetry(false)}
          disabled={retrying}
          className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20 disabled:opacity-50"
        >
          {retrying ? "Starting…" : "Render now"}
        </button>
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80">
      <AlertTriangleIcon className="h-7 w-7 text-red-400" />
      <span className="text-sm font-semibold leading-tight text-red-300">
        Render failed
      </span>
      <button
        type="button"
        onClick={() => void handleRetry(true)}
        disabled={retrying}
        className="rounded-md bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20 disabled:opacity-50"
      >
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
