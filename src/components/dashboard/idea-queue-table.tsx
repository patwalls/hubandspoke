"use client";

import { useEffect, useMemo, useState } from "react";
import { TriageDialog } from "./triage-dialog";
import { cn } from "@/lib/utils";
import { platformClass } from "@/lib/badge-colors";
import { AccountBadge } from "@/components/ui/account-badge";
import type { ProductionItem } from "@/types";

type SortKey = "channel" | "content" | "format" | "views";
type SortDir = "asc" | "desc";

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
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "views" ? "desc" : "asc");
    }
  };

  const sortedItems = useMemo(() => {
    if (!sortKey) return items;
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFn = (item: ProductionItem): string | number | null => {
      switch (sortKey) {
        case "channel":
          return item.platform?.[0]?.toLowerCase() ?? null;
        case "content":
          return item.title?.toLowerCase() ?? null;
        case "format":
          return item.format?.toLowerCase() ?? null;
        case "views":
          return item.prediction?.prediction ?? null;
      }
    };
    return [...items].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [items, sortKey, sortDir]);

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
            <col className="w-[240px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[100px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <SortableHeader
                label="Channel"
                sortKey="channel"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                className="whitespace-nowrap"
              />
              <SortableHeader
                label="Content"
                sortKey="content"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Format"
                sortKey="format"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
              />
              <SortableHeader
                label="Est. Views"
                sortKey="views"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title="Predicted views — based on past performance of similar content"
              />
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => (
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

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  align = "left",
  className,
  title,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey | null;
  direction: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
  className?: string;
  title?: string;
}) {
  const active = activeKey === sortKey;
  const arrow = !active ? "" : direction === "asc" ? "↑" : "↓";
  return (
    <th
      className={cn(
        "px-3 py-2.5 font-mono uppercase tracking-wider text-[10px] text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className
      )}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer",
          align === "right" && "justify-end",
          active && "text-foreground"
        )}
      >
        <span>{label}</span>
        <span
          className={cn(
            "inline-block w-2 text-[10px]",
            !active && "opacity-0"
          )}
          aria-hidden
        >
          {arrow}
        </span>
      </button>
    </th>
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
          {item.account ? (
            <AccountBadge
              account={item.account}
              postType={item.postType}
              variant="avatar"
            />
          ) : (
            item.platform?.map((p) => (
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
            ))
          )}
          {!item.account && !item.platform?.length && (
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
