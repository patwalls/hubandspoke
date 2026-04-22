"use client";

import {
  HeartIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  Repeat2Icon,
  SendIcon,
} from "lucide-react";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";

export function ThreadsSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
}: SimulatorProps) {
  const post = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "you";
  const slides = data.slides;

  return (
    <div className="mx-auto w-full max-w-[520px] rounded-xl border border-border bg-background text-foreground">
      <div className="flex gap-3 px-4 pt-3 pb-2">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className="text-sm font-semibold">{handle}</span>
              {data.author.verified && <VerifiedBadge />}
              <span className="text-xs text-muted-foreground">· 2h</span>
            </div>
            <MoreHorizontalIcon className="h-4 w-4 text-muted-foreground" />
          </div>

          <div className="mt-1 text-[15px] leading-snug">
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={post}
              placeholder="Start a thread…"
              multiline
              className="text-[15px] leading-snug"
            />
          </div>

          {slides.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <div className="relative aspect-square w-full bg-black">
                {slides[0].kind === "video" ? (
                  <video
                    src={slides[0].url ?? undefined}
                    poster={slides[0].posterUrl ?? undefined}
                    controls
                    playsInline
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : slides[0].url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={slides[0].url}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : null}
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center gap-5 text-muted-foreground">
            <HeartIcon className="h-4 w-4" />
            <MessageCircleIcon className="h-4 w-4" />
            <Repeat2Icon className="h-4 w-4" />
            <SendIcon className="h-4 w-4" />
          </div>
        </div>
      </div>
    </div>
  );
}
