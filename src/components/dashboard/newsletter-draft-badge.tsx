"use client";

// The queue's "Draft" badge on a newsletter edition that has been drafted but
// whose email draft isn't created yet (it stays in the queue until then, like
// a design before Save & export). Same look as the clip editor's ClipDraftBadge;
// one shared fetch for the whole table.

import { useEffect, useState } from "react";
import { PencilLineIcon } from "lucide-react";
import { useFeatureFlags } from "@/components/clip-editor/use-feature-flags";

let drafted: Set<string> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<void> {
  loading ??= fetch("/api/newsletter-drafts/drafted-items")
    .then((r) => (r.ok ? (r.json() as Promise<{ itemIds: string[] }>) : { itemIds: [] }))
    .then((j) => {
      drafted = new Set(j.itemIds);
    })
    .catch(() => {
      drafted = new Set();
    })
    .finally(() => {
      loading = null;
      for (const l of listeners) l();
    });
  return loading;
}

/** Re-read the badges (after the editor closes). */
export function refreshNewsletterDraftBadges(): void {
  void load();
}

export function NewsletterDraftBadge({ itemId, postType }: { itemId: string; postType: string | null | undefined }) {
  const flags = useFeatureFlags();
  const enabled = postType === "newsletter" && !!flags?.newsletterDrafter;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const onChange = () => rerender((n) => n + 1);
    listeners.add(onChange);
    if (drafted === null) void load();
    return () => {
      listeners.delete(onChange);
    };
  }, [enabled]);

  if (!enabled || !drafted?.has(itemId)) return null;
  return (
    <span
      title="Drafted and saved — open it to keep editing. It moves to production when you create the email draft."
      className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-800 dark:bg-sky-950 dark:text-sky-300"
    >
      <PencilLineIcon className="size-3" />
      Draft
    </span>
  );
}
