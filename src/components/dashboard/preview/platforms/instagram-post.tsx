"use client";

import { useState } from "react";
import {
  BookmarkIcon,
  HeartIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  SendIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import { formatCompactCount } from "../resolve-preview-data";
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
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "your_handle";
  const followerLabel =
    data.author.followerCount != null
      ? `${formatCompactCount(data.author.followerCount)} followers`
      : null;
  const estimatedLikes =
    data.author.followerCount != null
      ? Math.round(data.author.followerCount * 0.02)
      : null;

  return (
    <div className="mx-auto w-full max-w-[468px] overflow-hidden rounded-xl border border-border bg-background text-foreground">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="rounded-full bg-gradient-to-tr from-amber-400 via-rose-500 to-fuchsia-600 p-[2px]">
          <div className="rounded-full bg-background p-[2px]">
            <MonogramAvatar
              displayName={data.author.displayName}
              handle={data.author.handle}
              size="sm"
            />
          </div>
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1">
            <span className="truncate text-[13px] font-semibold">{handle}</span>
            {data.author.verified && <VerifiedBadge />}
          </div>
          {followerLabel && (
            <div className="text-[11px] text-muted-foreground">
              {followerLabel}
            </div>
          )}
        </div>
        <MoreHorizontalIcon className="h-5 w-5 text-foreground" />
      </div>

      {/* Media — wrapped with the dropzone so the user can drag-drop /
          click to add up to 10 photos/videos and × any existing slide. */}
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

      {/* Actions */}
      <div className="flex items-center gap-4 px-3 pt-3">
        <HeartIcon className="h-6 w-6" strokeWidth={1.75} />
        <MessageCircleIcon
          className="h-6 w-6 -scale-x-100"
          strokeWidth={1.75}
        />
        <SendIcon className="h-6 w-6" strokeWidth={1.75} />
        <BookmarkIcon className="ml-auto h-6 w-6" strokeWidth={1.75} />
      </div>

      {/* Likes + caption */}
      <div className="px-3 pb-3 pt-2 text-sm">
        {estimatedLikes != null && (
          <div className="mb-1 text-[13px] font-semibold">
            {formatCompactCount(estimatedLikes)} likes
          </div>
        )}
        <div className="leading-snug">
          <span className="mr-1.5 text-[13px] font-semibold">{handle}</span>
          <EditableField
            fieldKey={fieldMap.caption}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={caption}
            placeholder="Write a caption…"
            className="text-[13px] leading-snug"
          />
        </div>
        {data.publishedAt && (
          <div className="mt-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {new Date(data.publishedAt).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
            })}
          </div>
        )}
      </div>
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
      <div className="flex aspect-[4/5] items-center justify-center bg-muted text-xs text-muted-foreground">
        No media — drop photos or videos to add
      </div>
    );
  }
  return (
    <div className="relative w-full">
      <div
        className="flex aspect-[4/5] w-full snap-x snap-mandatory overflow-x-auto scroll-smooth bg-black [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            {entry.slide.kind === "video" ? (
              <video
                src={entry.slide.url ?? undefined}
                poster={entry.slide.posterUrl ?? undefined}
                controls
                playsInline
                className="h-full w-full object-contain"
              />
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
