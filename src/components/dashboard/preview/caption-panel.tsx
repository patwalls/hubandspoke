"use client";

import { useState } from "react";
import { SparklesIcon } from "lucide-react";
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
  /** Override the editable field's placeholder. Defaults to "Caption…",
   *  but each platform should pass its own — LinkedIn isn't a "caption",
   *  X says "What's happening?", etc. */
  placeholder?: string;
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
  placeholder,
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
        placeholder={placeholder ?? "Write a caption…"}
      />
    );
  }
  // Minimal layout: just the editable textarea (with the right per-platform
  // placeholder) and a top-right Regenerate button when applicable. No
  // hard-coded "CAPTION" label — LinkedIn doesn't have captions, X calls
  // it a tweet, etc. The placeholder carries the affordance.
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {showRegenerate && (
        <div className="mb-1.5 flex items-center justify-end">
          <RegenerateCaptionButton
            itemId={itemId}
            hasExisting={value.trim().length > 0}
            hasDraft={editable}
            onRegenerated={onRegenerated}
          />
        </div>
      )}
      <EditableField
        fieldKey={fieldKey}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        value={value}
        placeholder={placeholder ?? "Write something…"}
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
  placeholder,
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
  placeholder: string;
}) {
  const handle = author.handle ?? "your_handle";
  const displayName = author.displayName ?? handle;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      {/* Account header — borderless, just avatar + handle + subtitle.
       *  No card chrome, no faux engagement rail; the editor wants to see
       *  who's posting + edit the caption, that's it. */}
      <div className="flex items-center gap-2.5">
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
            <div className="text-xs text-muted-foreground">{subtitle}</div>
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
      </div>

      {/* Caption — editable textarea, no extra label or background. */}
      <EditableField
        fieldKey={fieldKey}
        editable={editable}
        onLocalEdit={onLocalEdit}
        onCommit={onCommit}
        value={value}
        placeholder={placeholder}
        multiline
        className="whitespace-pre-wrap text-sm leading-snug text-foreground"
      />
    </div>
  );
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

  // Label flips on first-vs-subsequent runs so the affordance is honest.
  // "Regenerate caption" (not just "Regenerate") because the button sits
  // next to the IG-embed video — bare "Regenerate" reads like it might
  // re-render the MP4.
  const label = busy
    ? "Generating…"
    : hasDraft
      ? "Regenerate caption"
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
