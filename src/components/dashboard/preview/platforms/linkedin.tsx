"use client";

import {
  GlobeIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  Repeat2Icon,
  SendIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function LinkedInSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  const displayName = data.author.displayName ?? data.author.handle ?? "You";
  const slides = data.slides;

  return (
    <div className="mx-auto w-full max-w-[560px] rounded-md border border-border bg-background text-foreground">
      <div className="flex items-start gap-2 px-4 pt-3">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">{displayName}</div>
          <div className="truncate text-xs text-muted-foreground">
            {data.author.followerCount != null
              ? `${data.author.followerCount.toLocaleString()} followers`
              : "Creator"}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>2h</span>
            <span>·</span>
            <GlobeIcon className="h-3 w-3" />
          </div>
        </div>
        <MoreHorizontalIcon className="h-4 w-4 text-muted-foreground" />
      </div>

      <div className="px-4 pt-2 pb-3">
        <EditableField
          fieldKey={fieldMap.caption}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={body}
          placeholder="What do you want to talk about?"
          multiline
          className="text-[14px] leading-snug"
        />
      </div>

      {slides.length > 0 && (
        <div className="w-full bg-black">
          {slides[0].kind === "video" ? (
            <video
              src={slides[0].url ?? undefined}
              poster={slides[0].posterUrl ?? undefined}
              controls
              playsInline
              className="aspect-video w-full object-cover"
            />
          ) : slides[0].url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slides[0].url}
              alt=""
              className="aspect-video w-full object-cover"
            />
          ) : null}
        </div>
      )}

      <div className="flex items-center justify-around border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
        <LiAction icon={<ThumbsUpIcon className="h-4 w-4" />} label="Like" />
        <LiAction icon={<MessageSquareIcon className="h-4 w-4" />} label="Comment" />
        <LiAction icon={<Repeat2Icon className="h-4 w-4" />} label="Repost" />
        <LiAction icon={<SendIcon className="h-4 w-4" />} label="Send" />
      </div>
    </div>
  );
}

function LiAction({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5">
      {icon}
      <span className="text-xs">{label}</span>
    </div>
  );
}
