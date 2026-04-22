"use client";

import { PlayIcon } from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function YouTubeSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const title = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const description = readLive(liveContent, fieldMap.caption, data.caption);
  const displayName = data.author.displayName ?? data.author.handle ?? "Channel";
  const firstSlide = data.slides[0];

  return (
    <div className="mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-background text-foreground">
      <div className="relative aspect-video w-full bg-black">
        {firstSlide?.kind === "video" ? (
          <video
            src={firstSlide.url ?? undefined}
            poster={firstSlide.posterUrl ?? undefined}
            controls
            playsInline
            className="h-full w-full object-cover"
          />
        ) : firstSlide?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={firstSlide.url}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-white/60">
            No thumbnail yet
          </div>
        )}
        {!firstSlide || firstSlide.kind !== "video" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex h-12 w-16 items-center justify-center rounded-md bg-black/60">
              <PlayIcon className="h-6 w-6 text-white" fill="white" />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex gap-3 px-4 py-3">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold leading-snug">
            <EditableField
              fieldKey={fieldMap.secondary}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={title}
              placeholder="Video title…"
              multiline
              className="text-base font-semibold leading-snug"
            />
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {displayName}
            {data.author.followerCount != null && (
              <>
                {" · "}
                {data.author.followerCount.toLocaleString()} subscribers
              </>
            )}
          </div>
          <div className="mt-2 rounded-md bg-muted/60 p-2 text-xs leading-snug text-muted-foreground">
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={description}
              placeholder="Description…"
              multiline
              className="text-xs leading-snug text-foreground"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
