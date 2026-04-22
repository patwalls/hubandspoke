"use client";

import {
  BookmarkIcon,
  HeartIcon,
  MessageCircleIcon,
  MusicIcon,
  SendIcon,
  UserPlusIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function TikTokSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const caption = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "you";
  const firstSlide = data.slides[0];

  return (
    <div className="mx-auto w-full max-w-[380px] overflow-hidden rounded-xl bg-black text-white">
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
            No video yet
          </div>
        )}

        {/* Right-side rail */}
        <div className="absolute right-2 bottom-28 flex flex-col items-center gap-5">
          <div className="relative">
            <MonogramAvatar
              displayName={data.author.displayName}
              handle={data.author.handle}
              size="md"
              className="border-2 border-white"
            />
            <div className="absolute -bottom-2 left-1/2 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-rose-500">
              <UserPlusIcon className="h-2.5 w-2.5" />
            </div>
          </div>
          <HeartIcon className="h-6 w-6" strokeWidth={1.8} />
          <MessageCircleIcon className="h-6 w-6" strokeWidth={1.8} />
          <BookmarkIcon className="h-6 w-6" strokeWidth={1.8} />
          <SendIcon className="h-6 w-6" strokeWidth={1.8} />
        </div>

        {/* Bottom caption */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-4 pt-12">
          <div className="mb-1 flex items-center gap-1 text-sm font-bold">
            @{handle}
            {data.author.verified && <VerifiedBadge tone="tiktok" />}
          </div>
          <EditableField
            fieldKey={fieldMap.caption}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={caption}
            placeholder="Caption…"
            multiline
            className="text-xs leading-snug text-white"
          />
          <div className="mt-2 flex items-center gap-1.5 text-[11px]">
            <MusicIcon className="h-3 w-3" />
            <span className="truncate">original sound — {handle}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
