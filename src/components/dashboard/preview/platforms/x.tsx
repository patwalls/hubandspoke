"use client";

import {
  BarChart2Icon,
  BookmarkIcon,
  HeartIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  Repeat2Icon,
  UploadIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import {
  DraftMediaDropZone,
  PlaceholderSlideRender,
} from "../draft-media-dropzone";

export function XSimulator({
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
  const handle = data.author.handle ?? "you";
  const displayName = data.author.displayName ?? handle;
  const slides = data.slides;

  return (
    <div className="mx-auto w-full max-w-[560px] rounded-xl border border-border bg-background text-foreground">
      <div className="flex gap-3 px-4 pt-3 pb-2">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1 leading-tight">
                <span className="truncate text-sm font-bold">{displayName}</span>
                {data.author.verified && <VerifiedBadge tone="x" />}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                @{handle}
              </div>
            </div>
            <MoreHorizontalIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          </div>

          <div className="mt-1.5 text-[15px] leading-snug">
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={caption}
              placeholder="What's happening?"
              multiline
              className="text-[15px] leading-snug"
            />
          </div>

          <DraftMediaDropZone
            itemId={itemId}
            postType="x"
            editable={editable}
            slides={slides}
            onMediaMutated={onMediaMutated}
          >
            {({ slides: enrichedSlides, placeholders }) => {
              const total = enrichedSlides.length + placeholders.length;
              if (total === 0) return null;
              const gridClass =
                total >= 4
                  ? "grid-cols-2 grid-rows-2 aspect-video"
                  : total === 3
                    ? "grid-cols-2 grid-rows-2 aspect-video"
                    : total === 2
                      ? "grid-cols-2 aspect-video"
                      : "grid-cols-1 aspect-video";
              return (
                <div
                  className={`mt-3 grid gap-0.5 overflow-hidden rounded-2xl border border-border ${gridClass}`}
                >
                  {enrichedSlides.slice(0, 4).map((entry, i) => {
                    const { slide, removeButton } = entry;
                    return (
                      <div
                        key={slide.mediaId ?? `slide-${i}`}
                        className={`group relative w-full bg-black ${
                          total === 3 && i === 0 ? "row-span-2" : ""
                        }`}
                      >
                        {removeButton}
                        {slide.kind === "video" ? (
                          <video
                            src={slide.url ?? undefined}
                            poster={slide.posterUrl ?? undefined}
                            controls
                            playsInline
                            className="h-full w-full object-cover"
                          />
                        ) : slide.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={slide.url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {placeholders
                    .slice(0, Math.max(0, 4 - enrichedSlides.length))
                    .map((p) => (
                      <div key={p.id} className="relative w-full">
                        <PlaceholderSlideRender placeholder={p} />
                      </div>
                    ))}
                </div>
              );
            }}
          </DraftMediaDropZone>

          <div className="mt-3 flex max-w-[420px] items-center justify-between text-xs text-muted-foreground">
            <ActionIcon icon={<MessageCircleIcon className="h-4 w-4" />} />
            <ActionIcon icon={<Repeat2Icon className="h-4 w-4" />} />
            <ActionIcon icon={<HeartIcon className="h-4 w-4" />} />
            <ActionIcon icon={<BarChart2Icon className="h-4 w-4" />} />
            <ActionIcon icon={<BookmarkIcon className="h-4 w-4" />} />
            <ActionIcon icon={<UploadIcon className="h-4 w-4" />} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionIcon({ icon }: { icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-muted-foreground">{icon}</div>
  );
}
