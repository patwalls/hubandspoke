"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trackUsage } from "@/lib/usage/track";
import type { EditorRewriteExample } from "@/lib/services/draft-algorithm/editor-rewrites";

interface LearnedEdits {
  format: string | null;
  examples: EditorRewriteExample[];
}

/**
 * "Learned from N recent edits" above the draft simulator (drafts-learn M3).
 * The Draft Algorithm reads the team's latest (AI draft → what an editor
 * published) pairs for the brand + format; this shows editors which ones, so
 * they can see their rewrites shape the next draft. Renders nothing until the
 * item has a draft that read them.
 */
export function LearnedEditsChip({ itemId, brand }: { itemId: string; brand: string }) {
  const [data, setData] = useState<LearnedEdits | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/production-items/${itemId}/learned-edits`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: LearnedEdits | null) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (!data || data.examples.length === 0) return null;
  const n = data.examples.length;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) trackUsage("drafts:learned-peek", brand);
      }}
    >
      <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors">
        <Sparkles className="h-3.5 w-3.5" />
        Learned from {n} recent {n === 1 ? "edit" : "edits"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] max-h-[460px] overflow-y-auto gap-3 p-3">
        <p className="text-xs text-muted-foreground">
          This AI draft was written after reading how editors rewrote the
          latest{data.format ? ` ${data.format}` : ""} drafts before publishing.
          Your edits teach the next one.
        </p>
        {data.examples.map((ex, i) => (
          <div key={i} className="space-y-1.5 rounded-md border bg-muted/30 p-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              AI draft{ex.editedAt ? ` · edited ${ex.editedAt}` : ""}
            </div>
            <p className="line-clamp-4 whitespace-pre-line text-xs text-muted-foreground line-through decoration-muted-foreground/40">
              {ex.draft}
            </p>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
              Editor published
            </div>
            <p className="line-clamp-6 whitespace-pre-line text-xs">{ex.edited}</p>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
