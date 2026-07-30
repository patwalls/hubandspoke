"use client";

import { useEffect, useState } from "react";
import { GitMerge, ExternalLink } from "lucide-react";
import type { ProductionItem } from "@/types";
import type { DuplicateGroup } from "@/app/api/reports/duplicates/route";
import { MergeModal } from "./merge-modal";

interface DuplicatesViewProps {
  brand: string;
}

function ItemCard({ item }: { item: ProductionItem }) {
  const account = item.account;
  const platform = account?.platform ?? (item.platform?.[0] ?? null);
  return (
    <div className="flex-1 min-w-0 rounded-lg border border-border bg-card p-3 space-y-1.5">
      <p className="text-sm font-medium line-clamp-2">{item.title ?? "(untitled)"}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {account && <span>@{account.handle}</span>}
        {platform && !account && <span>{platform}</span>}
        {item.publishedDate && <span>{item.publishedDate}</span>}
        {item.views != null && <span>{item.views.toLocaleString()} views</span>}
      </div>
      {item.sourceType && (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground capitalize">
          {item.sourceType.replace("_", " ")}
        </span>
      )}
      {item.publishedLink && (
        <a
          href={item.publishedLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors truncate max-w-full"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{item.publishedLink}</span>
        </a>
      )}
    </div>
  );
}

interface MergeState {
  primaryItem: ProductionItem;
  secondaryItem: ProductionItem;
}

export function DuplicatesView({ brand }: DuplicatesViewProps) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [mergeState, setMergeState] = useState<MergeState | null>(null);

  const loadGroups = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/reports/duplicates?brand=${encodeURIComponent(brand)}`);
      if (!res.ok) return;
      const json = await res.json() as { groups: DuplicateGroup[] };
      setGroups(json.groups);
    } catch {
      /* non-fatal */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadGroups(); }, [brand]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex items-center gap-2 text-muted-foreground">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm">Scanning for duplicates...</span>
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-12 text-center">
        <p className="text-sm font-medium text-foreground">No duplicates found</p>
        <p className="text-xs text-muted-foreground mt-1">
          No published items share a link or platform content ID on this brand.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {groups.length} duplicate {groups.length === 1 ? "group" : "groups"} found — items sharing the same published link or platform content ID.
        </p>

        {groups.map((group, gi) => (
          <div key={gi} className="rounded-xl border border-border bg-background p-4 space-y-3">
            {/* Items in the group */}
            <div className="flex flex-col sm:flex-row gap-3">
              {group.items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>

            {/* Merge actions — one button per item: clicking makes that item the primary (kept) */}
            <div className="flex flex-wrap gap-2 pt-1 border-t border-border">
              <span className="text-xs text-muted-foreground self-center">Keep which one?</span>
              {group.items.map((item, ii) => {
                const others = group.items.filter((_, j) => j !== ii);
                return (
                  <button
                    key={item.id}
                    onClick={() => setMergeState({ primaryItem: item, secondaryItem: others[0] })}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
                  >
                    <GitMerge className="size-3.5" />
                    Keep "{(item.title ?? "").slice(0, 30)}{(item.title?.length ?? 0) > 30 ? "…" : ""}"
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {mergeState && (
        <MergeModal
          open={!!mergeState}
          onOpenChange={(open) => { if (!open) setMergeState(null); }}
          primaryItem={mergeState.primaryItem}
          preselectedSecondaryItem={mergeState.secondaryItem}
          brand={brand}
          contentId={mergeState.primaryItem.id}
          onMergeComplete={() => {
            setMergeState(null);
            void loadGroups();
          }}
        />
      )}
    </>
  );
}
