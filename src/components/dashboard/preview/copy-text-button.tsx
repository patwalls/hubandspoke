"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { trackUsage } from "@/lib/usage/track";

/**
 * A quiet "Copy …" link under a draft field on the post page, so whoever
 * publishes can paste the text where the post goes live instead of
 * hand-selecting it out of the editor. Copies the value exactly as it reads
 * (local edits included). Renders nothing for an empty value.
 *
 * Every platform's preview uses it for the text that gets posted: the
 * caption / body / tweet / post, YouTube's title, and the CTA reply or
 * first comment. Marks: `content:caption-copied`, `content:title-copied`,
 * `content:cta-copied`.
 */
export function CopyTextButton({
  value,
  label = "Copy caption",
  mark = "content:caption-copied",
  title = "Copy the caption to paste where you publish",
  className,
}: {
  value: string;
  label?: string;
  mark?: string;
  title?: string;
  /** Overrides for the wrapper (alignment, spacing, colors on dark frames). */
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (value.trim().length === 0) return null;
  async function handleClick() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      trackUsage(mark);
    } catch {
      toast.error("Couldn't copy — select the text and copy it by hand");
    }
  }
  return (
    <div className={cn("mt-2 flex justify-end", className)}>
      <button
        type="button"
        onClick={() => void handleClick()}
        title={title}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
        {copied ? "Copied" : label}
      </button>
    </div>
  );
}
