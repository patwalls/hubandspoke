"use client";

import { toast } from "sonner";
import { MonogramAvatar } from "../avatar";
import { VerifiedBadge } from "../verified-badge";
import { EditableField } from "../editable-field";
import { readLive, type SimulatorProps } from "../simulator-types";
import { formatFeedTime } from "../resolve-preview-data";
import { PLATFORM_FONT } from "../platform-tokens";
import { CtaCard } from "../cta-card";
import { MediaActions } from "../media-actions";
import {
  ThreadsCommentIcon,
  ThreadsHeartIcon,
  ThreadsMoreIcon,
  ThreadsRepostIcon,
  ThreadsShareIcon,
} from "../icons/threads";

export function ThreadsSimulator({
  data,
  fieldMap,
  editable,
  liveContent,
  onLocalEdit,
  onCommit,
  itemId,
  onDraftMutated,
  descriptProjectUrl,
}: SimulatorProps) {
  const post = readLive(liveContent, fieldMap.caption, data.caption);
  const handle = data.author.handle ?? "you";
  const firstSlide = data.slides[0] ?? null;
  const time = formatFeedTime(data.publishedAt);
  // CTA reply thread — same pattern as X / LinkedIn / YT Community.
  // Threads gained a `cta` slot 2026-05-15 so the auto-drafted reply
  // (link + UTM) renders inline as a chained reply card.
  const ctaKey = fieldMap.cta;
  const showCta = !!ctaKey;
  const ctaValue = ctaKey ? readLive(liveContent, ctaKey, "") : "";

  return (
    <div
      className="mx-auto w-full max-w-[540px] rounded-2xl border border-[#e5e5e5] bg-white text-[#0a0a0a]"
      style={{ fontFamily: PLATFORM_FONT.threads }}
    >
      <div className="flex gap-3 px-4 pt-4">
        <MonogramAvatar
          displayName={data.author.displayName}
          handle={data.author.handle}
          avatarUrl={data.author.avatarUrl}
          size="md"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[15px] font-semibold leading-none">
                {handle}
              </span>
              {data.author.verified && <VerifiedBadge />}
              <span className="shrink-0 text-[15px] leading-none text-[#999]">
                {" \u00b7 "}
                {time}
              </span>
            </div>
            <ThreadsMoreIcon className="shrink-0 text-[#999]" />
          </div>

          <div className="mt-2 text-[15px] leading-[1.4] text-[#0a0a0a]">
            <EditableField
              fieldKey={fieldMap.caption}
              editable={editable}
              onLocalEdit={onLocalEdit}
              onCommit={onCommit}
              value={post}
              placeholder="Start a thread\u2026"
              multiline
              className="text-[15px] leading-[1.4]"
            />
          </div>

          {firstSlide && firstSlide.url && (
            <div className="group relative mt-3 overflow-hidden rounded-[12px] border border-[#e5e5e5] bg-black">
              {firstSlide.kind === "video" ? (
                <>
                  <video
                    src={firstSlide.url}
                    poster={firstSlide.posterUrl ?? undefined}
                    controls
                    playsInline
                    className="block h-auto max-h-[560px] w-full"
                  />
                  <MediaActions
                    src={firstSlide.url}
                    kind="video"
                    editUrl={descriptProjectUrl}
                    onResync={async () => {
                      await triggerResync(itemId);
                    }}
                  />
                </>
              ) : (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={firstSlide.url}
                    alt=""
                    className="block h-auto max-h-[560px] w-full object-cover"
                  />
                  <MediaActions src={firstSlide.url} />
                </>
              )}
            </div>
          )}

          <div className="mt-3 flex items-center gap-1 text-[#0a0a0a]">
            <ActionButton icon={<ThreadsHeartIcon />} />
            <ActionButton icon={<ThreadsCommentIcon />} />
            <ActionButton icon={<ThreadsRepostIcon />} />
            <ActionButton icon={<ThreadsShareIcon />} />
          </div>
        </div>
      </div>

      {showCta && ctaKey && (
        <div className="px-4 pt-3">
          <CtaCard
            variant="threads"
            fieldKey={ctaKey}
            value={ctaValue}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            author={data.author}
            itemId={itemId}
            onRegenerated={onDraftMutated}
          />
        </div>
      )}

      {data.publishedLink ? (
        <div className="flex items-center justify-end px-4 pt-3 pb-4">
          <a
            href={data.publishedLink}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e5e5] px-3 py-1.5 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-[#f5f5f5]"
          >
            View on Threads
            <ThreadsLogo className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : (
        <div className="pb-4" />
      )}
    </div>
  );
}

async function triggerResync(itemId: string | undefined): Promise<void> {
  if (!itemId) return;
  const res = await fetch(
    `/api/production-items/${itemId}/sync-descript-publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || `HTTP ${res.status}`);
  }
  toast.success("Re-syncing from Descript…", {
    description:
      "New MP4 will replace this one in ~2–10 min. The simulator updates automatically.",
  });
}

function ActionButton({ icon }: { icon: React.ReactNode }) {
  return (
    <span className="flex h-9 w-9 items-center justify-center rounded-full text-[#0a0a0a]">
      {icon}
    </span>
  );
}

function ThreadsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 192 192" className={className} aria-hidden>
      <path
        fill="currentColor"
        d="M141.5 87.5c-.7-.3-1.4-.7-2.1-1-1.2-22.9-13.7-36-34.7-36.2h-.3c-12.6 0-23 5.4-29.4 15.1l11.6 7.9c4.8-7.2 12.3-8.8 17.8-8.8h.2c6.9.1 12.1 2.1 15.4 6 2.4 2.8 4 6.7 4.8 11.7-6-1-12.5-1.4-19.4-1-19.6 1.1-32.2 12.6-31.3 28.5.4 8.1 4.4 15 11.4 19.6 5.9 3.9 13.5 5.8 21.5 5.4 10.5-.6 18.7-4.6 24.5-11.9 4.4-5.5 7.1-12.7 8.4-21.7 5.2 3.1 9 7.3 11.2 12.3 3.6 8.6 3.8 22.7-7.6 34.1-10 10-22 14.3-40.2 14.5-20.2-.2-35.5-6.6-45.5-19.2-9.3-11.8-14.1-28.7-14.3-50.4.2-21.6 5-38.6 14.3-50.4 10-12.6 25.2-19.1 45.5-19.2 20.4.2 35.9 6.7 46 19.4 4.9 6.2 8.6 14.1 11 23.2l13.2-3.5c-2.9-11.2-7.5-20.9-13.7-28.8C154.1 4.7 133.4-3.7 107.6-3.9h-.1c-25.8.2-46 8.6-60.3 25-13.3 15.4-20.1 36.8-20.4 63.7v.2c.3 26.9 7.1 48.3 20.4 63.7 14.3 16.4 34.5 24.8 60.3 25h.1c22.7-.2 38.7-5.8 51.9-18.5 17.3-16.6 16.8-37.5 11.1-50.3-4.1-9.2-11.8-16.6-22.1-21.4zm-36.5 27c-8.8.5-18-3.5-18.5-11.9-.4-6.2 4.4-13.1 19.1-13.9.5 0 1-.1 1.5-.1 5.5 0 10.6.5 15.2 1.5-1.7 21.3-11.4 23.9-17.3 24.3z"
      />
    </svg>
  );
}
