"use client";

import {
  BookmarkIcon,
  HeartIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  SendIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { SlideCarousel } from "../slide-carousel";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import { formatCompactCount } from "../resolve-preview-data";

export function InstagramPostSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
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

      {/* Media */}
      <SlideCarousel slides={data.slides} aspect="portrait-45" />

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
