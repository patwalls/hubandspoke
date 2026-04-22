"use client";

import {
  HeartIcon,
  MessageCircleIcon,
  MusicIcon,
  SendIcon,
  MoreVerticalIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function InstagramReelSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const hook = readLive(liveContent, fieldMap.secondary, data.secondaryText ?? "");
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
}
