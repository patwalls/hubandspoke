"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/ui/account-badge";
import { RepostTriageDialog } from "./repost-triage-dialog";
import type { RepostCandidate } from "@/lib/services/repost-candidates";

type SortKey = "channel" | "content" | "pillar" | "format" | "views" | "ratio";
type SortDir = "asc" | "desc";

interface RepostQueueTableProps {
  items: RepostCandidate[];
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

function relativeAge(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const days = ms / 86_400_000;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function RepostQueueTable({
  items,
  brand,
  emptyMessage,
  onMutate,
}: RepostQueueTableProps) {
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
    const keyFn = (item: RepostCandidate): string | number | null => {
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
          return item.hotnessRatio;
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
            <col className="w-[120px]" />
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
                title="Lifetime views — kept fresh by performance-decay"
              />
              <SortableHeader
                label="Hotness"
                sortKey="ratio"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title={
                  "How much this post outperformed its peers.\n\n" +
                  "Cohort tier (best first):\n" +
                  "  · Account — same format & post-type on this exact channel\n" +
                  "  · Brand   — same format & post-type across the brand\n" +
                  "  · Format  — cross-brand (last 365d)\n\n" +
                  "Bar: 75th percentile of cohort lifetime views.\n" +
                  "Admit: ratio ≥ 1.5× (≈ top 10-12% of evergreen).\n" +
                  "Sort: highest ratio first."
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
              <RepostQueueRow
                key={item.id}
                item={item}
                brand={brand}
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

function RepostQueueRow({
  item,
  brand,
  onActioned,
}: {
  item: RepostCandidate;
  brand: string;
  onActioned: () => void;
}) {
  const [open, setOpen] = useState(false);

  const top = item.topSignal!;
  // Repost v2 admits at ≥1.5×; we still tier the badge so the truly
  // crushing items pop visually.
  const ratioBadgeClass =
    top.ratio >= 5
      ? "bg-emerald-100 text-emerald-900 border-emerald-200"
      : top.ratio >= 3
        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
        : "bg-amber-100 text-amber-900 border-amber-200";

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
          {item.priorReposts.length > 0 && (
            <span
              className="text-[10px] text-muted-foreground whitespace-nowrap"
              title={`${item.priorReposts.length} prior repost${item.priorReposts.length === 1 ? "" : "s"}`}
            >
              · {item.priorReposts.length}× before
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
            "inline-flex flex-col items-end leading-tight rounded-md border px-2 py-1 whitespace-nowrap",
            ratioBadgeClass
          )}
          title={buildHotnessTooltip(item)}
        >
          <span className="font-semibold tabular-nums text-[12px]">
            {top.ratio.toFixed(1)}×
          </span>
          <span className="font-mono uppercase tracking-wider text-[9px] opacity-70">
            {top.cohortKind === "account"
              ? "ACCT"
              : top.cohortKind === "brand"
                ? "BRAND"
                : "FORMAT"}
          </span>
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-right text-muted-foreground tabular-nums whitespace-nowrap">
        {relativeAge(item.publishedAt ?? item.publishedDate)}
        <RepostTriageDialog
          open={open}
          onOpenChange={setOpen}
          candidate={item}
          brand={brand}
          onActioned={onActioned}
        />
      </td>
    </tr>
  );
}

function buildHotnessTooltip(item: RepostCandidate): string {
  const lines = [`Why this is hot:`, `  ${item.whyHot}`, "", `All signals:`];
  for (const s of item.hotnessSignals) {
    const pctLabel = `P${Math.round(s.percentile * 100)}`;
    const tierTag =
      s.cohortKind === "account"
        ? ""
        : s.cohortKind === "brand"
          ? " ↩ brand"
          : " ↩ cross-brand";
    lines.push(
      `  · ${s.label}: ${s.ratio.toFixed(2)}× (${formatCompact(s.views)} vs ${formatCompact(s.bar)} ${pctLabel} of ${s.cohortLabel}, cohort ${s.cohortSize})${tierTag}`
    );
  }
  lines.push("");
  lines.push("Cohort tier preference: account → brand → cross-brand format.");
  lines.push("Lifetime is the admission gate; velocity (when present) is");
  lines.push("supplementary evidence from the early hours after publish.");
  return lines.join("\n");
}
