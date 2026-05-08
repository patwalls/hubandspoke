"use client";

import { useState } from "react";
import {
  BookmarkIcon,
  HeartIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  MusicIcon,
  SendIcon,
  SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { EditableField } from "./editable-field";
import { MonogramAvatar } from "./avatar";
import { VerifiedBadge } from "./verified-badge";
import type { SimulatorProps } from "./simulator-types";
import type { PreviewData } from "./resolve-preview-data";

interface Props {
  itemId: string;
  fieldKey: string | null;
  value: string;
  editable: boolean;
  onLocalEdit?: SimulatorProps["onLocalEdit"];
  onCommit?: SimulatorProps["onCommit"];
  /** Show the AI-regenerate button for IG post types. Drives whether we
   *  surface the button at all — the API still gates per-item. */
  showRegenerate?: boolean;
  /** Fires after a successful regenerate — parent should refetch the
   *  draft so the new content lands in the editor. */
  onRegenerated?: () => void;
  /** Layout variant. "minimal" = label + caption only (used by X). "ig-embed"
   *  = account header + handle-prefixed caption + faux engagement rail
   *  (used by IG Reel + IG Post — looks like an instagram.com desktop
   *  embed without the pieces we don't have signal for). */
  variant?: "minimal" | "ig-embed";
  /** Author info for the ig-embed variant. Sourced from the joined
   *  account (or the snapshot fallback) via PreviewData.author. */
  author?: PreviewData["author"];
  /** ig-embed only: subtitle under the handle. "Original audio" for Reels,
   *  null for Posts. */
  subtitle?: string | null;
  /** ig-embed only: published-at timestamp shown under the caption.
   *  Formatted by the parent (or null if not yet published). */
  publishedAt?: string | null;
}

/**
 * Preview-side caption block. Two layouts:
 *   - "minimal" (default): a "CAPTION" label + the editable caption. Used
 *     by the X simulator where the platform mock doesn't add value.
 *   - "ig-embed": looks like instagram.com's desktop Reel/Post sidebar —
 *     account avatar + handle + verified + subtitle, then a handle-prefixed
 *     editable caption, then a faux like/comment/share rail. Editors get
 *     the visual fidelity they want without us mocking real engagement.
 *
 * The Regenerate button calls /api/production-items/[id]/generate-caption
 * which (re)runs the draft agent with the pillar transcript + past-format
 * captions and writes a new contentDrafts row.
 */
export function CaptionPanel({
  itemId,
  fieldKey,
  value,
  editable,
  onLocalEdit,
  onCommit,
  showRegenerate,
  onRegenerated,
  variant = "minimal",
  author,
  subtitle,
  publishedAt,
}: Props) {
  if (variant === "ig-embed" && author) {
    return (
      <IgEmbedCaption
        itemId={itemId}
        fieldKey={fieldKey}
        value={value}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        showRegenerate={showRegenerate}
        onRegenerated={onRegenerated}
        author={author}
        subtitle={subtitle ?? null}
        publishedAt={publishedAt ?? null}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Caption
        </span>
        {showRegenerate && (
          <RegenerateCaptionButton
            itemId={itemId}
            hasExisting={value.trim().length > 0}
            hasDraft={editable}
            onRegenerated={onRegenerated}
          />
        )}
      </div>
      <EditableField
        fieldKey={fieldKey}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        value={value}
        placeholder="Caption…"
        multiline
        className="whitespace-pre-wrap text-sm leading-snug text-foreground"
      />
    </div>
  );
}

function IgEmbedCaption({
  itemId,
  fieldKey,
  value,
  editable,
  onLocalEdit,
  onCommit,
  showRegenerate,
  onRegenerated,
  author,
  subtitle,
  publishedAt,
}: {
  itemId: string;
  fieldKey: string | null;
  value: string;
  editable: boolean;
  onLocalEdit?: SimulatorProps["onLocalEdit"];
  onCommit?: SimulatorProps["onCommit"];
  showRegenerate?: boolean;
  onRegenerated?: () => void;
  author: PreviewData["author"];
  subtitle: string | null;
  publishedAt: string | null;
}) {
  const handle = author.handle ?? "your_handle";
  const displayName = author.displayName ?? handle;
  const relativeTime = formatRelativeShort(publishedAt);
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border bg-background">
      {/* Account header */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <MonogramAvatar
          displayName={displayName}
          handle={handle}
          avatarUrl={author.avatarUrl ?? null}
          size="md"
        />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold">{handle}</span>
            {author.verified && <VerifiedBadge />}
          </div>
          {subtitle && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <MusicIcon className="h-3 w-3" />
              {subtitle}
            </div>
          )}
        </div>
        {showRegenerate && (
          <RegenerateCaptionButton
            itemId={itemId}
            hasExisting={value.trim().length > 0}
            hasDraft={editable}
            onRegenerated={onRegenerated}
          />
        )}
        <MoreHorizontalIcon
          className="h-5 w-5 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </div>

      {/* Caption block. IG renders the handle inline with the caption's
       *  first line, but inlining a textarea with a span breaks the cursor
       *  and makes long captions awkward to edit — so we float the handle
       *  on its own line above the editable textarea. Same column gutter
       *  (small avatar to the left) so it still reads like an IG comment
       *  block. */}
      <div className="flex items-start gap-2.5 px-4 py-3">
        <MonogramAvatar
          displayName={displayName}
          handle={handle}
          avatarUrl={author.avatarUrl ?? null}
          size="sm"
        />
        <div className="min-w-0 flex-1 text-sm leading-snug">
          <div className="mb-1 flex items-center gap-1">
            <span className="text-sm font-semibold">{handle}</span>
            {author.verified && <VerifiedBadge />}
          </div>
          <EditableField
            fieldKey={fieldKey}
            editable={editable}
            onLocalEdit={onLocalEdit}
            onCommit={onCommit}
            value={value}
            placeholder="Write a caption…"
            multiline
            className="whitespace-pre-wrap text-sm leading-snug text-foreground"
          />
          {relativeTime && (
            <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              {relativeTime}
            </div>
          )}
        </div>
      </div>

      {/* Faux engagement rail — decorative; we don't have real comment /
       *  like data on the simulator. Mirrors instagram.com layout so the
       *  editor sees the post in roughly its final shape. */}
      <div className="mt-auto flex items-center gap-4 border-t border-border px-4 py-3 text-muted-foreground">
        <HeartIcon className="h-5 w-5" strokeWidth={1.75} />
        <MessageCircleIcon className="h-5 w-5" strokeWidth={1.75} />
        <SendIcon className="h-5 w-5" strokeWidth={1.75} />
        <BookmarkIcon className="ml-auto h-5 w-5" strokeWidth={1.75} />
      </div>
    </div>
  );
}

/** "1d", "3h", "just now" — short relative time for the timestamp under
 *  the caption. Returns null when no publishedAt is set so we don't lie
 *  about timing on pre-publish drafts. */
function formatRelativeShort(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function RegenerateCaptionButton({
  itemId,
  hasExisting,
  hasDraft,
  onRegenerated,
}: {
  itemId: string;
  hasExisting: boolean;
  hasDraft: boolean;
  onRegenerated?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/production-items/${itemId}/generate-caption`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // force=true when there's already a draft caption present —
          // without it the service skips on the "already-filled" guard,
          // which is correct for auto-fire but wrong for an explicit
          // user click. `hasExisting && hasDraft` because an IG
          // clip-promotion has `item.contentBody` (clip-idea metadata)
          // but no draft row yet — the seeded text we want to overwrite
          // sits in `contentBody`, not the draft, so force isn't needed
          // for the first generate.
          body: JSON.stringify({ force: hasExisting && hasDraft }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't generate caption");
        return;
      }
      if (json?.status === "skipped") {
        toast.message("Skipped", { description: json.reason ?? "Nothing to do." });
        return;
      }
      toast.success(hasDraft ? "Caption regenerated" : "Caption generated");
      onRegenerated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate caption");
    } finally {
      setBusy(false);
    }
  }

  // Label flips on first-vs-subsequent runs so the affordance is honest:
  // "Generate" before any draft exists, "Regenerate" after the editor's
  // got something to replace.
  const label = busy
    ? "Generating…"
    : hasDraft
      ? "Regenerate"
      : "Generate caption";
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      title="Generate the caption from the pillar transcript + past captions for this format"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-50",
      )}
    >
      <SparklesIcon className={cn("h-3 w-3", busy && "animate-pulse")} />
      {label}
    </button>
  );
}
