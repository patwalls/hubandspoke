"use client";

import {
  HeartIcon,
  MessageCircleIcon,
  MoreVerticalIcon,
  SendIcon,
  ThumbsDownIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function YouTubeShortsSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const title = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
  const description = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "you";
  const firstSlide = data.slides[0];

  return (
    <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-xl border border-border bg-black text-white">
      <div className="relative aspect-[9/16] w-full">
        {firstSlide?.kind === "video" ? (
          <video
            src={firstSlide.url ?? undefined}
            poster={firstSlide.posterUrl ?? undefined}
            controls
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : firstSlide?.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={firstSlide.url}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
            No media yet
          </div>
        )}

        {/* Right-side actions */}
        <div className="absolute right-2 bottom-24 flex flex-col items-center gap-5">
          <HeartIcon className="h-6 w-6" strokeWidth={1.8} />
          <ThumbsDownIcon className="h-6 w-6" strokeWidth={1.8} />
          <MessageCircleIcon className="h-6 w-6" strokeWidth={1.8} />
          <SendIcon className="h-6 w-6" strokeWidth={1.8} />
          <MoreVerticalIcon className="h-6 w-6" strokeWidth={1.8} />
        </div>

        {/* Bottom gradient with author + title + description */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-3 pb-3 pt-10">
          <div className="mb-1.5 flex items-center gap-2">
            <MonogramAvatar
              displayName={data.author.displayName}
              handle={data.author.handle}
              size="sm"
            />
            <span className="text-xs font-semibold">@{handle}</span>
          </div>
          <div className="text-sm font-semibold leading-tight">
            <EditableField
              fieldKey={fieldMap.secondary}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={title}
              placeholder="Title…"
              multiline
              className="text-sm font-semibold leading-tight text-white"
            />
          </div>
          <div className="mt-1 text-[11px] leading-snug opacity-90">
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={description}
              placeholder="Description…"
              multiline
              className="text-[11px] leading-snug text-white/90"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
