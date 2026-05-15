"use client";

import { MonogramAvatar } from "../avatar";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import { formatFeedTime } from "../resolve-preview-data";
import { PLATFORM_FONT } from "../platform-tokens";
import { CtaCard } from "../cta-card";

// YouTube Community posts are text-first cards on the channel's Community
// tab. Layout mirrors the real feed: channel row on top, body text below,
// optional single image attached, thumbs up/down + comment action row.

export function YouTubeCommunitySimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onDraftMutated,
}: SimulatorProps) {
  const body = readLive(liveContent, fieldMap.caption, data.caption);
  const displayName = data.author.displayName ?? data.author.handle ?? "Channel";
  const firstSlide = data.slides[0] ?? null;
  const time = formatFeedTime(data.publishedAt);
  // CTA gate — see x.tsx for the rationale. CTA is part of the YouTube
  // Community post shape; always render when the platform has a cta slot.
  const ctaKey = fieldMap.cta;
  const showCta = !!ctaKey;
  const ctaValue = ctaKey ? readLive(liveContent, ctaKey, "") : "";

  return (
    <div
      className="mx-auto w-full max-w-[640px] rounded-xl border border-[#e5e5e5] bg-white px-4 py-4 text-[#0f0f0f]"
      style={{ fontFamily: PLATFORM_FONT.youtube_community }}
    >
      <div className="flex items-center gap-3">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium leading-tight text-[#0f0f0f]">
            {displayName}
          </div>
          <div className="mt-0.5 text-[12px] leading-tight text-[#606060]">
            {time}
          </div>
        </div>
      </div>

      <div className="mt-3 whitespace-pre-wrap text-[14px] leading-[1.45] text-[#0f0f0f]">
        <EditableField
          fieldKey={fieldMap.caption}
          editable={editable}
          onLocalEdit={onLocalEdit}
          onCommit={onCommit}
          value={body}
          placeholder="Write a post for the Community tab\u2026"
          multiline
          className="text-[14px] leading-[1.45]"
        />
      </div>

      {firstSlide && firstSlide.url && firstSlide.kind === "image" ? (
        <div className="mt-3 overflow-hidden rounded-[12px] bg-[#f2f2f2]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={firstSlide.url}
            alt=""
            className="block h-auto max-h-[520px] w-full object-cover"
          />
        </div>
      ) : firstSlide && firstSlide.kind === "video" ? (
        // Don't silently drop the video — tell the editor that Community
        // posts are image-only so they know to swap it before publish.
        <div className="mt-3 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900">
          Community posts don&rsquo;t support video. Drop an image instead, or
          publish this clip as a Short.
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 text-[#606060]">
        <YTAction label="Like" icon={<ThumbsUpIcon />} />
        <YTAction label="Dislike" icon={<ThumbsDownIcon />} />
        <YTAction label="Reply" icon={<CommentIcon />} />
      </div>

      {showCta && ctaKey && (
        <div className="mt-3 -mx-4">
          <CtaCard
            variant="youtube_community"
            fieldKey={ctaKey}
            value={ctaValue}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            author={data.author}
            maxLength={10000}
            itemId={itemId}
            onRegenerated={onDraftMutated}
          />
        </div>
      )}
    </div>
  );
}

function YTAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span
      className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[#0f0f0f]"
      aria-label={label}
    >
      {icon}
    </span>
  );
}

function ThumbsUpIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M7 10v10H4V10h3Zm3-6c.83 0 1.5.67 1.5 1.5V9h5.3c.99 0 1.78.87 1.67 1.86l-.88 8A1.69 1.69 0 0 1 15.9 20H10V10l3.5-6H10Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThumbsDownIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M17 14V4h3v10h-3Zm-3 6c-.83 0-1.5-.67-1.5-1.5V15H7.2c-.99 0-1.78-.87-1.67-1.86l.88-8A1.69 1.69 0 0 1 8.1 4H14v10l-3.5 6H14Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      <path
        d="M21 6v10a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
