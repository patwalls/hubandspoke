"use client";

import { useState } from "react";
import { SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { EditableField } from "./editable-field";
import type { SimulatorProps } from "./simulator-types";

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
}

/**
 * Minimalist preview-side caption block. Used by IG Reel / IG Post / X
 * simulators in place of full platform-mock chrome — the team iterates on
 * the caption text 100x more than they look at the faux engagement rail.
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
}: Props) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Caption
        </span>
        {showRegenerate && editable && (
          <RegenerateCaptionButton
            itemId={itemId}
            hasExisting={value.trim().length > 0}
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

function RegenerateCaptionButton({
  itemId,
  hasExisting,
  onRegenerated,
}: {
  itemId: string;
  hasExisting: boolean;
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
          // force=true when an existing caption is present — without it the
          // service skips on the "already-filled" guard, which is correct
          // for auto-fire but wrong for an explicit user click.
          body: JSON.stringify({ force: hasExisting }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json?.error || "Couldn't regenerate caption");
        return;
      }
      if (json?.status === "skipped") {
        toast.message("Skipped", { description: json.reason ?? "Nothing to do." });
        return;
      }
      toast.success("Caption regenerated");
      onRegenerated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't regenerate caption");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={busy}
      title="Regenerate caption from the pillar transcript + past captions for this format"
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:opacity-50",
      )}
    >
      <SparklesIcon className={cn("h-3 w-3", busy && "animate-pulse")} />
      {busy ? "Generating…" : "Regenerate"}
    </button>
  );
}
