"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { AccountBadge } from "@/components/ui/account-badge";
import { SpokeTriageDialog } from "./spoke-triage-dialog";
import type { SpokeCandidate } from "@/lib/services/spoke-candidates";

type SortKey = "channel" | "pillar" | "format" | "views" | "score";
type SortDir = "asc" | "desc";

interface SpokeQueueTableProps {
  items: SpokeCandidate[];
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

export function SpokeQueueTable({
  items,
  brand,
  emptyMessage,
  onMutate,
}: SpokeQueueTableProps) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "views" || key === "score" ? "desc" : "asc");
    }
  };

  const sortedItems = useMemo(() => {
    if (!sortKey) return items;
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFn = (item: SpokeCandidate): string | number | null => {
      switch (sortKey) {
        case "channel":
          return `${item.pillar.account.platform}:${item.pillar.account.handle.toLowerCase()}`;
        case "pillar":
          return item.pillar.title?.toLowerCase() ?? null;
        case "format":
          return item.format.name.toLowerCase();
        case "views":
          return item.pillar.views;
        case "score":
          return item.spokeScore;
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
            <col className="w-[200px]" />
            <col />
            <col className="w-[220px]" />
            <col className="w-[90px]" />
            <col className="w-[140px]" />
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
                label="Pillar Views"
                sortKey="views"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title="Lifetime views on the pillar YouTube video"
              />
              <SortableHeader
                label="SPOKE"
                sortKey="score"
                activeKey={sortKey}
                direction={sortDir}
                onSort={toggleSort}
                align="right"
                className="whitespace-nowrap"
                title={
                  "How strongly we think this (pillar × format) pair will perform.\n\n" +
                  "SPOKE = pillarStrength × formatFit × freshness × pairHistory\n\n" +
                  "  · pillarStrength : pillar views ÷ this channel's lifetime P60\n" +
                  "                     for YouTube long-form (last 365 days).\n" +
                  "  · formatFit      : (format P60 ÷ brand-all P60) × pair lift\n" +
                  "                     for repurposes from this channel.\n" +
                  "  · freshness      : exp(-ageDays/45), floored at 0.15.\n" +
                  "  · pairHistory    : boost if this exact (pillar × format)\n" +
                  "                     pair has shipped well before; dampen if\n" +
                  "                     killed or under-performed. 1.0 = no history.\n\n" +
                  "Admit when SPOKE ≥ 1.0. Sort: highest first."
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
              <SpokeQueueRow
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
        className,
      )}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer",
          align === "right" && "justify-end",
          active && "text-foreground",
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

function SpokeQueueRow({
  item,
  brand,
  onActioned,
}: {
  item: SpokeCandidate;
  brand: string;
  onActioned: () => void;
}) {
  const [open, setOpen] = useState(false);

  const score = item.spokeScore;
  const scoreBadgeClass =
    score >= 5
      ? "bg-emerald-100 text-emerald-900 border-emerald-200"
      : score >= 2.5
        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
        : score >= 1.5
          ? "bg-amber-100 text-amber-900 border-amber-200"
          : "bg-muted text-muted-foreground border-border";

  const dominant = pickDominantComponent(item);

  return (
    <tr className="border-b border-border/50 hover:bg-accent/30 transition-colors">
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1 min-w-0">
          <AccountBadge
            account={item.pillar.account}
            postType="youtube_long"
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
            title={item.pillar.title || "(Untitled)"}
          >
            {item.pillar.title || "(Untitled)"}
          </button>
          {item.priorAttempts.filter((p) => p.status === "Published").length >
            0 && (
            <span
              className="text-[10px] text-muted-foreground whitespace-nowrap"
              title={`${
                item.priorAttempts.filter((p) => p.status === "Published")
                  .length
              } prior shipped derivative${
                item.priorAttempts.filter((p) => p.status === "Published")
                  .length === 1
                  ? ""
                  : "s"
              } of this pair`}
            >
              ·{" "}
              {item.priorAttempts.filter((p) => p.status === "Published").length}
              × before
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-muted-foreground max-w-[220px]">
        <div className="truncate" title={item.format.name}>
          {item.format.name}
        </div>
      </td>
      <td className="px-3 py-2 text-sm text-right tabular-nums text-foreground">
        {item.pillar.publishedLink ? (
          <Link
            href={item.pillar.publishedLink}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary hover:underline transition-colors"
          >
            {formatCompact(item.pillar.views)}
          </Link>
        ) : (
          formatCompact(item.pillar.views)
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <span
          className={cn(
            "inline-flex flex-col items-end leading-tight rounded-md border px-2 py-1 whitespace-nowrap",
            scoreBadgeClass,
          )}
          title={buildSpokeTooltip(item)}
        >
          <span className="font-semibold tabular-nums text-[12px]">
            {score.toFixed(1)}×
          </span>
          <span className="font-mono uppercase tracking-wider text-[9px] opacity-70">
            {dominant}
          </span>
        </span>
      </td>
      <td className="px-3 py-2 text-xs text-right text-muted-foreground tabular-nums whitespace-nowrap">
        {relativeAge(item.pillar.publishedAt ?? item.pillar.publishedDate)}
        <SpokeTriageDialog
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

function pickDominantComponent(item: SpokeCandidate): string {
  const b = item.breakdown;
  const components: Array<[string, number]> = [
    ["PILLAR", b.pillarStrength],
    ["FORMAT", b.formatFit],
    ["HISTORY", b.pairHistoryMultiplier],
  ];
  components.sort((a, b2) => b2[1] - a[1]);
  return components[0][0];
}

function buildSpokeTooltip(item: SpokeCandidate): string {
  const b = item.breakdown;
  const lines = [
    `Why this pair scores ${item.spokeScore.toFixed(2)}×:`,
    `  ${item.whySpoke}`,
    "",
    "Components:",
    `  · Pillar strength : ${b.pillarStrength.toFixed(2)}×  (${formatCompact(
      item.pillar.views,
    )} views vs P60 ${formatCompact(b.pillarChannelP60)}, cohort ${b.pillarChannelCohortSize})`,
    `  · Format fit      : ${b.formatFit.toFixed(2)}×  (format P60 ${formatCompact(
      b.formatBrandP60,
    )} vs brand P60 ${formatCompact(b.brandAllFormatsP60)}${
      b.pairSourceCohortSize > 0
        ? `; pair lift ${(b.pairSourceP50 / Math.max(1, b.formatBrandP60)).toFixed(2)}× from ${b.pairSourceCohortSize} prior repurposes off this channel`
        : ""
    })`,
    `  · Freshness       : ${b.freshnessFactor.toFixed(2)}×  (pillar is ${Math.round(b.ageDays)}d old)`,
    `  · Pair history    : ${b.pairHistoryMultiplier.toFixed(2)}×  ${
      item.priorAttempts.length === 0
        ? "(no prior attempts)"
        : `(${item.priorAttempts.length} prior attempt${item.priorAttempts.length === 1 ? "" : "s"})`
    }`,
    "",
    "SPOKE = pillar × format × freshness × history. ≥ 1.0 admits.",
  ];
  return lines.join("\n");
}
