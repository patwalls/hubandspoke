"use client";

import {
  BookmarkIcon,
  HeartIcon,
  Loader2Icon,
  MessageCircleIcon,
  MusicIcon,
  SendIcon,
  MoreVerticalIcon,
} from "lucide-react";
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
  processing,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const hook = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const handle = data.author.handle ?? "you";
  const displayName = data.author.displayName ?? handle;

  // Processing state with no media yet: render the desktop-style "Reel
  // embed" mock — black 9:16 placeholder on the left, account/caption/
  // comments column on the right. Drops the dropzone too (per the user:
  // "don't show anything here in this preview" while processing — show
  // the embedded layout instead). Once the rendered MP4 lands, we fall
  // back to the existing portrait simulator below.
  const noMedia = data.slides.length === 0;
  if (processing && noMedia) {
    return (
      <div className="mx-auto flex w-full max-w-[640px] gap-0 overflow-hidden rounded-xl border border-border bg-background text-foreground">
        {/* LEFT: video placeholder, 9:16 */}
        <div className="relative aspect-[9/16] w-[180px] shrink-0 bg-black">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-white/70">
            <Loader2Icon className="h-5 w-5 animate-spin" />
            <span className="text-[11px] font-medium leading-tight">
              Rendering in Descript…
            </span>
            <span className="text-[10px] leading-tight text-white/50">
              Usually about 2 minutes. The video will appear here automatically.
            </span>
          </div>
        </div>

        {/* RIGHT: account + caption + faux engagement */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 pt-3">
            <MonogramAvatar
              displayName={data.author.displayName}
              handle={data.author.handle}
              size="sm"
            />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1">
                <span className="truncate text-[13px] font-semibold">
                  {displayName}
                </span>
                {data.author.verified && <VerifiedBadge />}
              </div>
              <div className="text-[11px] text-muted-foreground">
                Original audio
              </div>
            </div>
            <MoreVerticalIcon className="h-4 w-4 text-muted-foreground" />
          </div>

          <div className="px-3 pt-2 text-xs leading-snug">
            <span className="mr-1.5 text-[12px] font-semibold">{handle}</span>
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={caption}
              placeholder="Caption…"
              multiline
              className="text-[12px] leading-snug"
            />
          </div>

          {fieldMap.secondary && (
            <div className="mt-2 px-3 text-[11px] text-muted-foreground">
              <span className="mr-1.5 font-mono uppercase tracking-wider">
                Hook
              </span>
              <EditableField
                fieldKey={fieldMap.secondary}
                editable={editable}
                onLocalEdit={onLocalEdit}
                onCommit={onCommit}
                value={hook}
                placeholder="On-screen hook…"
                multiline
                className="text-[11px] leading-snug text-foreground"
              />
            </div>
          )}

          <div className="mt-auto flex items-center gap-3 border-t border-border px-3 py-2 text-muted-foreground">
            <HeartIcon className="h-4 w-4" strokeWidth={1.75} />
            <MessageCircleIcon className="h-4 w-4" strokeWidth={1.75} />
            <SendIcon className="h-4 w-4" strokeWidth={1.75} />
            <BookmarkIcon className="ml-auto h-4 w-4" strokeWidth={1.75} />
          </div>
        </div>
      </div>
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
