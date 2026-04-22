"use client";

import { useEffect, useState } from "react";
import { TriageDialog } from "./triage-dialog";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import type { ProductionItem } from "@/types";

interface AssignableUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface IdeaQueueTableProps {
  items: ProductionItem[];
  brand: string;
  emptyMessage: string;
  onMutate: () => void;
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-emerald-500",
  med: "bg-amber-500",
  low: "bg-muted-foreground/40",
};

export function IdeaQueueTable({
  items,
  brand,
  emptyMessage,
  onMutate,
}: IdeaQueueTableProps) {
  const [users, setUsers] = useState<AssignableUser[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/users/assignable");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setUsers(json.users || []);
      } catch {
        // Non-fatal — the picker just won't suggest anyone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-muted-foreground text-sm border border-border rounded-lg bg-card">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs table-fixed">
          <colgroup>
            <col className="w-[180px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[100px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap">
                Channel
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Content
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Format
              </th>
              <th
                className="px-3 py-2.5 text-right font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap"
                title="Predicted views — based on past performance of similar content"
              >
                Est. Views
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <IdeaQueueRow
                key={item.id}
                item={item}
                brand={brand}
                users={users}
                onDone={onMutate}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function IdeaQueueRow({
  item,
  brand,
  users,
  onDone,
}: {
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <tr className="border-b border-border/50 hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1 min-w-0">
          {item.platform?.map((p) => (
            <span
              key={p}
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border max-w-full truncate",
                platformClass(p)
              )}
              title={p}
            >
              {p}
            </span>
          ))}
          {!item.platform?.length && (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {item.sourceType === "repost" && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-900 border border-amber-200 shrink-0"
              title="Reposting an existing piece of content"
            >
              Repost
            </span>
          )}
          {item.sourceType === "cross_post" && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-100 text-indigo-900 border border-indigo-200 shrink-0"
              title="Same content syndicated to a different platform"
            >
              Cross-post
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-left text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors truncate block min-w-0"
            title={item.title || "(Untitled)"}
          >
            {item.title || "(Untitled)"}
          </button>
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground max-w-[220px]">
        <div className="truncate" title={item.format || ""}>
          {item.format || "—"}
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-right tabular-nums">
        {item.prediction && item.prediction.prediction != null ? (
          <div
            className="inline-flex items-center gap-1.5 justify-end"
            title={`Range ${formatCompact(item.prediction.p25)}–${formatCompact(
              item.prediction.p75
            )} · ${item.prediction.confidence} confidence${
              item.prediction.cohortBreakdown.length
                ? ` · ${item.prediction.cohortBreakdown
                    .map(
                      (c) =>
                        `${c.label}: ${c.n} posts, median ${formatCompact(c.median)}`
                    )
                    .join(" · ")}`
                : ""
            }`}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                CONFIDENCE_DOT[item.prediction.confidence] ??
                  CONFIDENCE_DOT.low
              )}
              aria-hidden
            />
            <span className="text-foreground">
              {formatCompact(item.prediction.prediction)}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        <TriageDialog
          open={open}
          onOpenChange={setOpen}
          item={item}
          brand={brand}
          users={users}
          onDone={onDone}
        />
      </td>
    </tr>
  );
}
