"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ChevronRightIcon } from "lucide-react";
import type { MetricData, Period, PrimaryRowMeta } from "@/types";
import { AccountBadge } from "@/components/ui/account-badge";
import { PlatformIcon } from "@/components/ui/platform-icon";
import { PLATFORM_META, POST_TYPE_SHORT_LABEL, toPlatform } from "@/lib/platforms";
import type { PostType } from "@/lib/platform-field-schemas";
import { cn } from "@/lib/utils";

function formatPeriodTooltip(p: Period): string {
  const s = new Date(p.start + "T00:00:00");
  const e = new Date(p.end + "T00:00:00");
  if (p.start === p.end) return format(s, "EEEE, MMMM do, yyyy");
  return `${format(s, "EEEE, MMMM do")} to ${format(e, "EEEE, MMMM do")}`;
}

function buildContentUrl(
  brand: string,
  filterKey: "platform" | "format",
  rowLabel: string | null,
  startDate: string,
  endDate: string,
): string {
  const params = new URLSearchParams();
  if (rowLabel) params.set(filterKey, rowLabel);
  params.set("startDate", startDate);
  params.set("endDate", endDate);
  return `/${brand}/content?${params.toString()}`;
}

type MetricKey = "production" | "views" | "leads" | "viewsPerPost" | "sales";

interface PeriodTableProps {
  title: string;
  description: string;
  periods: Period[];
  metrics: Record<string, MetricData>;
  tabs: { key: MetricKey; label: string }[];
  brand?: string;
  filterKey?: "platform" | "format";
  /** Optional per-row metadata. When present the primary table groups rows
   *  by `meta.platform` (YouTube, Instagram, …) and renders collapsible
   *  parent rows with summed totals. Expand a platform row to fan out its
   *  per-account children. Passed through as-is by the format-scoped
   *  tables (which don't have account metadata) — the fallback branch
   *  renders the legacy flat list. */
  rowMeta?: Record<string, PrimaryRowMeta>;
}

function formatValue(value: number, metricKey: MetricKey): string {
  if (value === 0) return "-";
  if (metricKey === "sales") {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }
  if (metricKey === "views" || metricKey === "viewsPerPost") {
    return value.toLocaleString();
  }
  return value.toString();
}

export function PeriodTable({
  title,
  description,
  periods,
  metrics,
  tabs,
  brand,
  filterKey = "platform",
  rowMeta,
}: PeriodTableProps) {
  const [activeTab, setActiveTab] = useState<MetricKey>(tabs[0].key);
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(
    () => new Set(),
  );
  const rangeStart = periods[0]?.start ?? "";
  const rangeEnd = periods[periods.length - 1]?.end ?? "";
  const linkable = Boolean(brand);

  const cellContent = (
    displayValue: string,
    value: number,
    rowLabel: string | null,
    periodStart: string,
    periodEnd: string,
  ) => {
    if (!linkable || value === 0) return displayValue;
    return (
      <Link
        href={buildContentUrl(brand!, filterKey, rowLabel, periodStart, periodEnd)}
        className="hover:underline"
      >
        {displayValue}
      </Link>
    );
  };

  const data = metrics[activeTab] || {};
  const rows = Object.keys(data).sort();

  // Grouping: when rowMeta is supplied, bucket rows by their platform so
  // the UI can render collapsible platform parents. Rows without meta go
  // into a "Misc" bucket rendered flat at the bottom.
  const groups = useMemo(() => {
    if (!rowMeta) return null;
    const byPlatform = new Map<string, { platform: string; rows: string[] }>();
    const misc: string[] = [];
    for (const row of rows) {
      const meta = rowMeta[row];
      if (!meta?.platform) {
        misc.push(row);
        continue;
      }
      const p = meta.platform;
      if (!byPlatform.has(p)) byPlatform.set(p, { platform: p, rows: [] });
      byPlatform.get(p)!.rows.push(row);
    }
    // Stable order: sort platforms alphabetically by label, then children
    // alphabetically by row label.
    const sortedPlatforms = Array.from(byPlatform.values()).sort((a, b) =>
      PLATFORM_META[toPlatform(a.platform)].label.localeCompare(
        PLATFORM_META[toPlatform(b.platform)].label
      )
    );
    for (const g of sortedPlatforms) g.rows.sort();
    return { platforms: sortedPlatforms, misc: misc.sort() };
  }, [rowMeta, rows]);

  // Per-row totals (reused by flat + grouped renders).
  const rowTotals: Record<string, number> = {};
  rows.forEach((row) => {
    if (activeTab === "viewsPerPost") {
      const prodData = metrics["production"]?.[row] || {};
      const viewsData = metrics["views"]?.[row] || {};
      const totalProd = Object.values(prodData).reduce((a, b) => a + b, 0);
      const totalViews = Object.values(viewsData).reduce((a, b) => a + b, 0);
      rowTotals[row] = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
    } else {
      rowTotals[row] = Object.values(data[row] || {}).reduce((a, b) => a + b, 0);
    }
  });

  // Platform-level aggregation for grouped render. Sum the children's
  // per-period values; viewsPerPost is a weighted average via the
  // underlying production/views sums so it stays meaningful.
  const sumPeriodForRows = (
    childRows: string[],
    periodLabel: string,
    which: MetricKey,
  ): number => {
    if (which === "viewsPerPost") {
      let prod = 0;
      let views = 0;
      for (const r of childRows) {
        prod += metrics["production"]?.[r]?.[periodLabel] || 0;
        views += metrics["views"]?.[r]?.[periodLabel] || 0;
      }
      return prod > 0 ? Math.round(views / prod) : 0;
    }
    return childRows.reduce(
      (sum, r) => sum + ((metrics[which] || {})[r]?.[periodLabel] || 0),
      0,
    );
  };
  const sumRangeForRows = (
    childRows: string[],
    which: MetricKey,
  ): number => {
    if (which === "viewsPerPost") {
      let prod = 0;
      let views = 0;
      for (const r of childRows) {
        prod += Object.values(metrics["production"]?.[r] || {}).reduce(
          (a, b) => a + b,
          0,
        );
        views += Object.values(metrics["views"]?.[r] || {}).reduce(
          (a, b) => a + b,
          0,
        );
      }
      return prod > 0 ? Math.round(views / prod) : 0;
    }
    return childRows.reduce((sum, r) => sum + (rowTotals[r] || 0), 0);
  };

  const periodTotals: Record<string, number> = {};
  periods.forEach((p) => {
    if (activeTab === "viewsPerPost") {
      const totalProd = rows.reduce(
        (sum, row) => sum + (metrics["production"]?.[row]?.[p.label] || 0), 0
      );
      const totalViews = rows.reduce(
        (sum, row) => sum + (metrics["views"]?.[row]?.[p.label] || 0), 0
      );
      periodTotals[p.label] = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
    } else {
      periodTotals[p.label] = rows.reduce(
        (sum, row) => sum + (data[row]?.[p.label] || 0), 0
      );
    }
  });

  let grandTotal: number;
  if (activeTab === "viewsPerPost") {
    const totalProd = rows.reduce((sum, row) => {
      const prodData = metrics["production"]?.[row] || {};
      return sum + Object.values(prodData).reduce((a, b) => a + b, 0);
    }, 0);
    const totalViews = rows.reduce((sum, row) => {
      const viewsData = metrics["views"]?.[row] || {};
      return sum + Object.values(viewsData).reduce((a, b) => a + b, 0);
    }, 0);
    grandTotal = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
  } else {
    grandTotal = Object.values(rowTotals).reduce((a, b) => a + b, 0);
  }

  function togglePlatform(platform: string) {
    setExpandedPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  // Render helpers — a platform parent row and a per-account child row.
  // Both live alongside the legacy flat render so format-scoped tables
  // (no rowMeta) keep their current shape.
  const renderChildRow = (row: string) => (
    <tr
      key={row}
      className="border-b border-border/50 hover:bg-accent/20 transition-colors"
    >
      <td className="sticky left-0 bg-card pr-3 sm:pr-4 py-2 pl-10 sm:pl-14 text-xs sm:text-sm font-medium text-foreground z-10">
        {rowMeta?.[row] ? (
          // Build the label inline so we always show the post-type suffix
          // inside this grouped view — AccountBadge's default suppresses
          // it when the post_type equals the platform's default, which is
          // exactly the case that's ambiguous here ("@starter_story" sitting
          // next to "@starter_story · Post" with no Reel label).
          <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm">
            <PlatformIcon platform={rowMeta[row].platform} size={14} />
            <span>@{rowMeta[row].handle}</span>
            {rowMeta[row].postType ? (
              <span className="text-muted-foreground">
                · {POST_TYPE_SHORT_LABEL[rowMeta[row].postType as PostType] ?? rowMeta[row].postType}
              </span>
            ) : null}
          </span>
        ) : (
          row
        )}
      </td>
      {periods.map((p) => {
        const value = data[row]?.[p.label] || 0;
        const display = formatValue(value, activeTab);
        return (
          <td
            key={p.label}
            className={`px-2 py-2 text-center tabular-nums ${
              value === 0 ? "text-border" : "text-foreground"
            }`}
          >
            {cellContent(display, value, row, p.start, p.end)}
          </td>
        );
      })}
      <td className="px-3 py-2 text-center font-semibold text-foreground bg-accent/30 tabular-nums">
        {cellContent(
          formatValue(rowTotals[row], activeTab),
          rowTotals[row],
          row,
          rangeStart,
          rangeEnd,
        )}
      </td>
    </tr>
  );

  const renderPlatformParent = (
    platform: string,
    childRows: string[],
    expanded: boolean,
  ) => {
    const platformLabel = PLATFORM_META[toPlatform(platform)].label;
    const rangeTotal = sumRangeForRows(childRows, activeTab);
    return (
      <tr
        key={`platform-${platform}`}
        onClick={() => togglePlatform(platform)}
        className={cn(
          "border-b border-border hover:bg-accent/40 transition-colors cursor-pointer select-none",
          expanded && "bg-accent/20",
        )}
      >
        <td className="sticky left-0 bg-inherit px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-foreground z-10">
          <div className="flex items-center gap-2">
            <ChevronRightIcon
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            <PlatformIcon platform={platform} size={14} />
            <span>{platformLabel}</span>
            <span className="text-[10px] font-normal text-muted-foreground tabular-nums">
              {childRows.length}
            </span>
          </div>
        </td>
        {periods.map((p) => {
          const v = sumPeriodForRows(childRows, p.label, activeTab);
          return (
            <td
              key={p.label}
              className={`px-2 py-2 text-center tabular-nums font-medium ${
                v === 0 ? "text-border" : "text-foreground"
              }`}
            >
              {formatValue(v, activeTab)}
            </td>
          );
        })}
        <td className="px-3 py-2 text-center font-semibold text-foreground bg-accent/40 tabular-nums">
          {formatValue(rangeTotal, activeTab)}
        </td>
      </tr>
    );
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>

      <div className="px-3 sm:px-5 py-2 border-b border-border flex gap-1 bg-accent/30 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-accent"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <th className="sticky left-0 bg-accent/50 px-3 sm:px-4 py-2.5 text-left font-medium text-muted-foreground min-w-[120px] sm:min-w-[220px] z-10 font-mono uppercase tracking-wider text-[10px]">
                Metric
              </th>
              {periods.map((p) => (
                <th
                  key={p.label}
                  title={formatPeriodTooltip(p)}
                  className="px-2 py-2.5 text-center font-medium text-muted-foreground min-w-[52px] font-mono uppercase tracking-wider text-[10px] cursor-help"
                >
                  {p.label}
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-medium text-foreground min-w-[64px] bg-accent font-mono uppercase tracking-wider text-[10px]">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {groups ? (
              <>
                {groups.platforms.map((g) => {
                  const expanded = expandedPlatforms.has(g.platform);
                  return (
                    <>
                      {renderPlatformParent(g.platform, g.rows, expanded)}
                      {expanded && g.rows.map((row) => renderChildRow(row))}
                    </>
                  );
                })}
                {groups.misc.map((row) => renderChildRow(row))}
              </>
            ) : (
              rows.map((row) => (
                <tr
                  key={row}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="sticky left-0 bg-card px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium text-foreground z-10">
                    {row}
                  </td>
                  {periods.map((p) => {
                    const value = data[row]?.[p.label] || 0;
                    const display = formatValue(value, activeTab);
                    return (
                      <td
                        key={p.label}
                        className={`px-2 py-2 text-center tabular-nums ${
                          value === 0 ? "text-border" : "text-foreground"
                        }`}
                      >
                        {cellContent(display, value, row, p.start, p.end)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center font-semibold text-foreground bg-accent/30 tabular-nums">
                    {cellContent(
                      formatValue(rowTotals[row], activeTab),
                      rowTotals[row],
                      row,
                      rangeStart,
                      rangeEnd,
                    )}
                  </td>
                </tr>
              ))
            )}
            <tr className="border-t-2 border-border bg-accent/50 font-semibold">
              <td className="sticky left-0 bg-accent/50 px-3 sm:px-4 py-2 text-xs sm:text-sm text-foreground z-10 font-mono uppercase tracking-wider text-[10px]">
                Total
              </td>
              {periods.map((p) => {
                const v = periodTotals[p.label];
                return (
                  <td
                    key={p.label}
                    className="px-2 py-2 text-center text-foreground tabular-nums"
                  >
                    {cellContent(formatValue(v, activeTab), v, null, p.start, p.end)}
                  </td>
                );
              })}
              <td className="px-3 py-2 text-center text-foreground bg-accent tabular-nums">
                {cellContent(
                  formatValue(grandTotal, activeTab),
                  grandTotal,
                  null,
                  rangeStart,
                  rangeEnd,
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
