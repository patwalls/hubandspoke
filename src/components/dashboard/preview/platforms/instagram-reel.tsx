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
  // Show the render-state placeholder whenever Descript work isn't done.
  // Cover-image fallback slides (built from `posterS3Key` when no
  // `production_item_media` row exists yet) leave `data.slides[0].kind ==
  // "image"` — without this fix the "Awaiting render" placeholder + its
  // "Render now" button were hidden behind a static cover, leaving the
  // editor with no way to kick off the publish from the simulator.
  const hasArchivedVideo = data.slides.some(
    (s) => s.kind === "video" && !!s.url,
  );
  const showStatePlaceholder = !!descriptRenderState && !hasArchivedVideo;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 sm:flex-row">
      {/* LEFT: 9:16 video player or render-state placeholder. No overlays
       *  on the video itself — the burned-in hook text already lives in
       *  the rendered MP4, and a duplicate simulator overlay just clashes
       *  with it. `group` on the wrapper enables the hover-reveal of the
       *  MediaActions overlay (Resync / Download / Copy). */}
      <div className="group relative aspect-[9/16] w-full max-w-[320px] shrink-0 overflow-hidden rounded-lg bg-black">
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
                  {enriched?.slide.kind === "video" && enriched.slide.url ? (
                    <>
                      <video
                        src={enriched.slide.url}
                        poster={enriched.slide.posterUrl ?? undefined}
                        controls
                        playsInline
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                      <MediaActions
                        src={enriched.slide.url}
                        kind="video"
                        onResync={async () => {
                          await triggerResync(itemId);
                        }}
                      />
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

      {/* RIGHT: ig-embed-style sidebar — account avatar + handle +
       *  "Original audio", then a handle-prefixed editable caption, then
       *  a faux engagement rail. Visually mirrors instagram.com so the
       *  editor sees the post roughly as it'll ship. */}
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
        subtitle="Original audio"
        publishedAt={data.publishedAt}
      />
    </div>
  );
}

/**
 * Re-sync the rendered MP4 from Descript. Hits the same endpoint as the
 * "Re-sync from Descript" button in the DescriptStatusPill popover, with
 * `force: true` so it kicks off a fresh publish job even if the existing
 * rendered MP4 looks complete. Used by the MediaActions overlay on the
 * playable video — editors who tweak the composition in Descript want to
 * pull the new render without digging into menus.
 */
async function triggerResync(itemId: string): Promise<void> {
  const res = await fetch(
    `/api/production-items/${itemId}/sync-descript-publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  toast.success("Re-syncing from Descript…", {
    description:
      "New MP4 will replace this one in ~2–10 min. The simulator updates automatically.",
  });
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
