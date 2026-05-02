"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/ui/account-badge";
import { CrossPostTriageDialog } from "./cross-post-triage-dialog";
import type {
  BrandAccount,
  CrossPostCandidate,
} from "@/lib/services/cross-post-candidates";

type SortKey = "channel" | "content" | "pillar" | "format" | "views" | "ratio";
type SortDir = "asc" | "desc";

interface CrossPostQueueTableProps {
  items: CrossPostCandidate[];
  brandAccounts: BrandAccount[];
  brand: string;
  emptyMessage: string;
  targetCommonality?: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  onMutate: () => void;
}

function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function relativeAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const hrs = ms / 3_600_000;
  if (hrs < 1) return `${Math.round(ms / 60_000)}m`;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

export function CrossPostQueueTable({
  items,
  brandAccounts,
  brand,
  emptyMessage,
  targetCommonality,
  onMutate,
}: CrossPostQueueTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "views" || key === "ratio" ? "desc" : "asc");
    }
  };

  const sortedItems = useMemo(() => {
    if (!sortKey) return items;
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFn = (item: CrossPostCandidate): string | number | null => {
      switch (sortKey) {
        case "channel":
          return `${item.account.platform}:${item.account.handle.toLowerCase()}`;
        case "content":
          return item.title?.toLowerCase() ?? null;
        case "pillar":
          return item.pillarContentTitle?.toLowerCase() ?? null;
        case "format":
          return item.format?.toLowerCase() ?? null;
        case "views":
          return item.views;
        case "ratio":
          return item.formatRatio;
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
            <col className="w-[200px]" />
            <col className="w-[200px]" />
            <col className="w-[90px]" />
            <col className="w-[100px]" />
            <col className="w-[60px]" />
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
                label="Pillar"
                sortKey="pillar"
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
                label="Views"
                sortKey="views"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title="Total views — fresh within ~1h via the performance-decay sync"
              />
              <SortableHeader
                label="vs P75"
                sortKey="ratio"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title={
                  "How this post stacks up against its format.\n\n" +
                  "P75 = 75th-percentile views among every Published post in the same format over the last 90 days. " +
                  "It's the bar that separates the top 25% from the rest.\n\n" +
                  "The number shown is this post's views ÷ that bar:\n" +
                  "  · 1.0× = exactly at the bar (top quartile entry)\n" +
                  "  · 2.0× = double the bar\n\n" +
                  "Formats with fewer than 10 recent posts are skipped."
                }
              />
              <th
                scope="col"
                className="px-3 py-2.5 text-right font-mono uppercase tracking-wider text-[10px] text-muted-foreground whitespace-nowrap"
              >
                Age
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item) => (
              <CrossPostQueueRow
                key={item.id}
                item={item}
                brandAccounts={brandAccounts}
                brand={brand}
                targetCommonality={targetCommonality}
                onActioned={onMutate}
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
          className={cn("inline-block w-2 text-[10px]", !active && "opacity-0")}
          aria-hidden
        >
          {arrow}
        </span>
      </button>
    </th>
  );
}

function CrossPostQueueRow({
  item,
  brandAccounts,
  brand,
  targetCommonality,
  onActioned,
}: {
  item: CrossPostCandidate;
  brandAccounts: BrandAccount[];
  brand: string;
  targetCommonality?: Record<
    string,
    Array<{ accountId: string; postType: string; count: number }>
  >;
  onActioned: () => void;
}) {
  const [open, setOpen] = useState(false);

  const ratioLabel = `${item.formatRatio.toFixed(1)}×`;
  const ratioBadgeClass =
    item.formatRatio >= 3
      ? "bg-emerald-100 text-emerald-900 border-emerald-200"
      : item.formatRatio >= 1.5
      ? "bg-amber-100 text-amber-900 border-amber-200"
      : "bg-muted text-muted-foreground border-border";

  return (
    <tr className="border-b border-border/50 hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1 min-w-0">
          <AccountBadge
            account={item.account}
            postType={item.postType}
            variant="avatar"
          />
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-left text-sm font-medium text-foreground hover:text-primary hover:underline transition-colors truncate block min-w-0"
            title={item.title || "(Untitled)"}
          >
            {item.title || "(Untitled)"}
          </button>
          {item.existingCrossPosts.length > 0 && (
            <span
              className="text-[10px] text-muted-foreground whitespace-nowrap"
              title={`${item.existingCrossPosts.length} cross-post${
                item.existingCrossPosts.length === 1 ? "" : "s"
              } already created`}
            >
              · {item.existingCrossPosts.length} done
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground max-w-[200px]">
        {item.pillarContentItemId && item.pillarContentTitle ? (
          <Link
            href={`/${brand}/content/${item.pillarContentItemId}`}
            className="truncate block hover:text-primary hover:underline transition-colors"
            title={item.pillarContentTitle}
          >
            {item.pillarContentTitle}
          </Link>
        ) : (
          <span className="truncate block">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground max-w-[200px]">
        <div className="truncate" title={item.format || ""}>
          {item.format || "—"}
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-right tabular-nums text-foreground">
        {formatCompact(item.views)}
      </td>
      <td className="px-3 py-2 text-right">
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] tabular-nums border",
            ratioBadgeClass
          )}
          title={[
            `This post: ${(item.views ?? 0).toLocaleString()} views`,
            `${item.format} P75: ${item.formatP75.toLocaleString()} views`,
            `Ratio: ${item.formatRatio.toFixed(2)}× the P75 bar`,
            "",
            "P75 = 75th-percentile views across every Published",
            "post in this format over the last 90 days",
            `(cohort: ${item.formatCohortSize} posts). It's the line`,
            "that separates the top 25% from the rest, so 1.0×",
            "means this post just edges into the top quartile.",
          ].join("\n")}
        >
          {ratioLabel}
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-right text-muted-foreground tabular-nums whitespace-nowrap">
        {relativeAge(item.publishedAt ?? item.publishedDate)}
        <CrossPostTriageDialog
          open={open}
          onOpenChange={setOpen}
          candidate={item}
          brandAccounts={brandAccounts}
          brand={brand}
          targetCommonality={targetCommonality}
          onActioned={onActioned}
        />
      </td>
    </tr>
  );
}
