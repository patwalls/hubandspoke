"use client";

import { useState } from "react";
import {
  AlertTriangleIcon,
  BookmarkIcon,
  HeartIcon,
  Loader2Icon,
  MessageCircleIcon,
  MusicIcon,
  SendIcon,
  MoreVerticalIcon,
  PlayCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
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
  descriptRenderState,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const hook = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const handle = data.author.handle ?? "you";
  const displayName = data.author.displayName ?? handle;

  // Descript-derived clip with no archived MP4 yet: render the desktop
  // Instagram Reel embed mock — black 9:16 placeholder on the LEFT,
  // account header + editable hook + editable caption + faux engagement
  // on the RIGHT. Drops the dropzone (per the user: while processing,
  // don't show "Drag a video to add" — show the eventual layout).
  // Once the rendered MP4 lands and a productionItemMedia row exists,
  // descriptRenderState flips to null and we fall through to the
  // existing portrait simulator below.
  const noMedia = data.slides.length === 0;
  if (descriptRenderState && descriptRenderState !== null && noMedia) {
    return (
      <ReelEmbedPlaceholder
        state={descriptRenderState}
        itemId={itemId}
        editable={editable}
        liveContent={liveContent}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        fieldMap={fieldMap}
        caption={caption}
        hook={hook}
        handle={handle}
        displayName={displayName}
        verified={data.author.verified}
      />
    );
  }

  return (
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
          <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-xl border border-border bg-black text-white">
            <div className="group relative aspect-[9/16] w-full">
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

              {/* Remove button (only when an actual slide is present) */}
              {enriched?.removeButton}

              {/* Top-right menu dot */}
              <div className="absolute right-2 top-2">
                <MoreVerticalIcon className="h-5 w-5 text-white drop-shadow" />
              </div>

              {/* On-screen hook overlay — editable when draft available */}
              <div className="pointer-events-none absolute inset-x-4 top-1/4 text-center">
                <div className="pointer-events-auto inline-block max-w-full">
                  <EditableField
                    fieldKey={fieldMap.secondary}
                    editable={editable}
                    onLocalEdit={onLocalEdit}
                    onCommit={onCommit}
                    value={hook}
                    placeholder="On-screen hook…"
                    multiline
                    className="text-balance text-center text-xl font-black leading-tight uppercase tracking-tight text-white [text-shadow:_0_2px_6px_rgb(0_0_0_/_0.65)]"
                  />
                </div>
              </div>

              {/* Right-side action rail */}
              <div className="absolute right-2 bottom-24 flex flex-col items-center gap-5 text-white">
                <div className="flex flex-col items-center gap-0.5">
                  <HeartIcon className="h-6 w-6" strokeWidth={1.8} />
                  <span className="text-[11px]">—</span>
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <MessageCircleIcon className="h-6 w-6" strokeWidth={1.8} />
                  <span className="text-[11px]">—</span>
                </div>
                <SendIcon className="h-6 w-6" strokeWidth={1.8} />
                <MusicIcon className="h-5 w-5" strokeWidth={1.8} />
              </div>

              {/* Bottom caption */}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8">
                <div className="mb-1.5 flex items-center gap-2">
                  <MonogramAvatar
                    displayName={data.author.displayName}
                    handle={data.author.handle}
                    size="sm"
                  />
                  <span className="text-xs font-semibold">{handle}</span>
                  {data.author.verified && <VerifiedBadge className="h-3 w-3" />}
                </div>
                <EditableField
                  fieldKey={fieldMap.caption}
                  editable={editable}
                  onLocalEdit={onLocalEdit}
                  onCommit={onCommit}
                  value={caption}
                  placeholder="Caption…"
                  multiline
                  className="line-clamp-3 text-xs leading-snug text-white"
                />
              </div>
            </div>
          </div>
        );
      }}
    </DraftMediaDropZone>
  );
}

/**
 * Instagram-desktop-reel-embed placeholder. Fires when the clip is
 * Descript-derived but no MP4 is archived yet. Layout mirrors what an
 * editor sees on instagram.com viewing a Reel: video on the LEFT (here
 * a sub-state-aware placeholder), account header + editable caption +
 * editable hook + faux engagement column on the RIGHT.
 */
function ReelEmbedPlaceholder(props: {
  state: "rendering" | "awaiting" | "failed";
  itemId: string;
  editable: boolean;
  liveContent: SimulatorProps["liveContent"];
  onLocalEdit: SimulatorProps["onLocalEdit"];
  onCommit: SimulatorProps["onCommit"];
  fieldMap: SimulatorProps["fieldMap"];
  caption: string;
  hook: string;
  handle: string;
  displayName: string;
  verified: boolean;
}) {
  const {
    state,
    itemId,
    editable,
    onLocalEdit,
    onCommit,
    fieldMap,
    caption,
    hook,
    handle,
    displayName,
    verified,
  } = props;
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

  return (
    <div className="mx-auto flex w-full max-w-[760px] overflow-hidden rounded-lg border border-border bg-background text-foreground">
      {/* LEFT: 9:16 video placeholder */}
      <div className="relative aspect-[9/16] w-[360px] shrink-0 bg-black">
        {state === "rendering" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80">
            <Loader2Icon className="h-7 w-7 animate-spin text-white/90" />
            <span className="text-sm font-semibold leading-tight">
              Rendering MP4 in Descript…
            </span>
            <span className="text-xs leading-snug text-white/55">
              Usually 2–10 minutes. The video will appear here automatically.
            </span>
          </div>
        )}
        {state === "awaiting" && (
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
        )}
        {state === "failed" && (
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
        )}
      </div>

      {/* RIGHT: account + editable caption / hook + faux engagement */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2.5 px-4 pt-4">
          <MonogramAvatar displayName={displayName} handle={handle} size="md" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="flex items-center gap-1">
              <span className="truncate text-sm font-semibold">{displayName}</span>
              {verified && <VerifiedBadge />}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <MusicIcon className="h-3 w-3" /> Original audio
            </div>
          </div>
          <MoreVerticalIcon className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="px-4 pt-4">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">
            On-screen hook
          </div>
          <EditableField
            fieldKey={fieldMap.secondary}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={hook}
            placeholder="On-screen hook…"
            multiline
            className="text-sm font-semibold leading-snug"
          />
        </div>

        <div className="mt-3 px-4">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Caption
          </div>
          <div className="leading-snug">
            <span className="mr-1.5 text-sm font-semibold">{handle}</span>
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={caption}
              placeholder="Caption…"
              multiline
              className="text-sm leading-snug"
            />
          </div>
        </div>

        <div className="mt-auto flex items-center gap-4 border-t border-border px-4 py-3 text-muted-foreground">
          <HeartIcon className="h-5 w-5" strokeWidth={1.75} />
          <MessageCircleIcon className="h-5 w-5" strokeWidth={1.75} />
          <SendIcon className="h-5 w-5" strokeWidth={1.75} />
          <BookmarkIcon className="ml-auto h-5 w-5" strokeWidth={1.75} />
        </div>
      </div>
    </div>
  );
}
