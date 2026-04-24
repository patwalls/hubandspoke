"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { TriageDialog } from "./triage-dialog";
import { BulkKillDialog } from "./bulk-kill-dialog";
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkKillOpen, setBulkKillOpen] = useState(false);
  const [bulkKilling, setBulkKilling] = useState(false);

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

  // Prune selection to ids that are still in the visible list — keeps selection
  // sane when the user changes filters or items refresh.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map((i) => i.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

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

  const allVisibleSelected =
    items.length > 0 && items.every((i) => selected.has(i.id));
  const someVisibleSelected = !allVisibleSelected && selected.size > 0;

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const i of items) next.add(i.id);
      } else {
        for (const i of items) next.delete(i.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function bulkKill(reason: string) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkKilling(true);
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch("/api/production-items", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id,
              status: "Killed",
              killReason: reason,
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error || `HTTP ${res.status}`);
            }
          })
        )
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      if (failed === 0) {
        toast.success(
          `Killed ${ok} idea${ok === 1 ? "" : "s"}`,
          { duration: 4000 }
        );
      } else if (ok === 0) {
        toast.error(`Failed to kill ${failed} idea${failed === 1 ? "" : "s"}`);
      } else {
        toast.warning(
          `Killed ${ok}, but ${failed} failed`,
          { duration: 6000 }
        );
      }
      setBulkKillOpen(false);
      clearSelection();
      onMutate();
    } finally {
      setBulkKilling(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-muted-foreground text-sm border border-border rounded-lg bg-card">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 flex justify-end pointer-events-none">
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-card/95 backdrop-blur pl-3 pr-1 py-1 shadow-md">
            <span className="text-xs text-foreground">
              <span className="font-semibold tabular-nums">{selected.size}</span>
              <span className="text-muted-foreground"> selected</span>
            </span>
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBulkKillOpen(true)}
              disabled={bulkKilling}
              className="inline-flex items-center rounded-full bg-red-600 px-3 h-7 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              Kill {selected.size}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs table-fixed">
            <colgroup>
              <col className="w-[36px]" />
              <col className="w-[240px]" />
              <col />
              <col className="w-[220px]" />
              <col className="w-[100px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-accent/50">
                <th className="px-3 py-2.5">
                  <CheckboxCell
                    checked={allVisibleSelected}
                    indeterminate={someVisibleSelected}
                    onChange={(checked) => toggleAllVisible(checked)}
                    ariaLabel={
                      allVisibleSelected
                        ? "Deselect all"
                        : "Select all visible ideas"
                    }
                  />
                </th>
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
                  isSelected={selected.has(item.id)}
                  onToggleSelected={(checked) => toggleOne(item.id, checked)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <BulkKillDialog
        open={bulkKillOpen}
        onOpenChange={(o) => {
          if (!bulkKilling) setBulkKillOpen(o);
        }}
        count={selected.size}
        saving={bulkKilling}
        onConfirm={bulkKill}
      />
    </div>
  );
}

function CheckboxCell({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label
      className="group/checkbox flex items-center justify-center cursor-pointer"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="relative grid size-4 grid-cols-1">
        <input
          type="checkbox"
          aria-label={ariaLabel}
          checked={checked}
          ref={(el) => {
            if (el) el.indeterminate = indeterminate;
          }}
          onChange={(e) => onChange(e.target.checked)}
          className={cn(
            "col-start-1 row-start-1 size-4 appearance-none rounded-[5px] border bg-white cursor-pointer transition-colors",
            "border-input hover:border-[#ff7a59]",
            "checked:border-[#ff5c35] checked:bg-[#ff5c35]",
            "indeterminate:border-[#ff5c35] indeterminate:bg-[#ff5c35]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff5c35]"
          )}
        />
        {/* Checkmark — visible only when checked */}
        <svg
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden
          className={cn(
            "pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white",
            checked && !indeterminate ? "opacity-100" : "opacity-0"
          )}
        >
          <path
            d="M3 8L6 11L11 3.5"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {/* Indeterminate dash — visible only when indeterminate */}
        <svg
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden
          className={cn(
            "pointer-events-none col-start-1 row-start-1 size-3.5 self-center justify-self-center stroke-white",
            indeterminate ? "opacity-100" : "opacity-0"
          )}
        >
          <path
            d="M3 7H11"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </label>
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
  isSelected,
  onToggleSelected,
}: {
  item: ProductionItem;
  brand: string;
  users: AssignableUser[];
  onDone: () => void;
  isSelected: boolean;
  onToggleSelected: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <tr
      className={cn(
        "border-b border-border/50 transition-colors",
        isSelected
          ? "bg-[#ff7a59]/10 hover:bg-[#ff7a59]/15"
          : "hover:bg-accent/30"
      )}
    >
      <td className="px-3 py-2 align-middle">
        <CheckboxCell
          checked={isSelected}
          onChange={onToggleSelected}
          ariaLabel={isSelected ? "Deselect idea" : "Select idea"}
        />
      </td>
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
          {(!item.sourceType || item.sourceType === "original") && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-900 border border-emerald-200 shrink-0"
              title="Brand-new original content"
            >
              Original
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
