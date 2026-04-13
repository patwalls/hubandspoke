"use client";

import { useState } from "react";
import type { ProductionItem } from "@/types";

interface PerformanceTableProps {
  items: ProductionItem[];
}

type SortKey =
  | "title"
  | "publishedDate"
  | "views"
  | "likes"
  | "comments"
  | "clicks"
  | "leads"
  | "salesAmount";

function getFreshness(item: ProductionItem): {
  color: string;
  label: string;
  dotClass: string;
} {
  if (!item.lastPerformanceSyncAt) {
    return { color: "text-red-500", label: "Never", dotClass: "bg-red-400" };
  }
  const elapsed = Date.now() - new Date(item.lastPerformanceSyncAt).getTime();
  const hours = elapsed / (1000 * 60 * 60);
  const days = hours / 24;

  if (hours < 1) return { color: "text-green-600", label: "Just now", dotClass: "bg-green-400" };
  if (hours < 6) return { color: "text-green-600", label: `${Math.floor(hours)}h ago`, dotClass: "bg-green-400" };
  if (hours < 24) return { color: "text-green-600", label: `${Math.floor(hours)}h ago`, dotClass: "bg-green-400" };
  if (days < 3) return { color: "text-yellow-600", label: `${Math.floor(days)}d ago`, dotClass: "bg-yellow-400" };
  if (days < 7) return { color: "text-yellow-600", label: `${Math.floor(days)}d ago`, dotClass: "bg-yellow-400" };
  return { color: "text-muted-foreground", label: `${Math.floor(days)}d ago`, dotClass: "bg-gray-400" };
}

export function PerformanceTable({ items }: PerformanceTableProps) {
  const hasThumbnails = items.some((item) => item.thumbnail);
  const hasPerformanceSync = items.some((item) => item.lastPerformanceSyncAt);
  const [sortKey, setSortKey] = useState<SortKey>("publishedDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sorted = [...items].sort((a, b) => {
    const aVal = a[sortKey];
    const bVal = b[sortKey];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (typeof aVal === "string" && typeof bVal === "string") {
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === "asc"
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  function SortHeader({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) {
    const isActive = sortKey === sortKeyName;
    return (
      <th
        className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground cursor-pointer hover:text-foreground select-none whitespace-nowrap transition-colors"
        onClick={() => handleSort(sortKeyName)}
      >
        <span className="inline-flex items-center gap-1">
          {label}
          {isActive && (
            <span className="text-foreground">{sortDir === "asc" ? "\u2191" : "\u2193"}</span>
          )}
        </span>
      </th>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-4 sm:px-5 py-3 sm:py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Content Performance</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Individual content items with detailed metrics
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-accent/50">
              <SortHeader label="Title" sortKeyName="title" />
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Platform
              </th>
              <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                Format
              </th>
              <SortHeader label="Published" sortKeyName="publishedDate" />
              {hasPerformanceSync && (
                <th className="px-3 py-2.5 text-left font-mono uppercase tracking-wider text-[10px] text-muted-foreground">
                  Synced
                </th>
              )}
              <SortHeader label="Views" sortKeyName="views" />
              <SortHeader label="Likes" sortKeyName="likes" />
              <SortHeader label="Comments" sortKeyName="comments" />
              <SortHeader label="Clicks" sortKeyName="clicks" />
              <SortHeader label="Leads" sortKeyName="leads" />
              <SortHeader label="Sales $" sortKeyName="salesAmount" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border/50 hover:bg-accent/30 transition-colors"
              >
                <td className="px-3 py-2 max-w-[200px] sm:max-w-[360px]">
                  <div className="flex items-center gap-3">
                    {hasThumbnails && item.thumbnail && (
                      <img
                        src={item.thumbnail}
                        alt=""
                        className="w-20 h-12 rounded object-cover shrink-0"
                      />
                    )}
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">
                        {item.publishedLink ? (
                          <a
                            href={item.publishedLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary hover:underline transition-colors"
                          >
                            {item.title || "(Untitled)"}
                          </a>
                        ) : (
                          item.title || "(Untitled)"
                        )}
                      </span>
                      {item.utmCampaign && (
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {item.utmCampaign}
                        </span>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {item.platform?.map((p) => (
                      <span
                        key={p}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent text-muted-foreground border border-border"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm text-muted-foreground">{item.format || "-"}</td>
                <td className="px-3 py-2 text-sm text-muted-foreground whitespace-nowrap">
                  {item.publishedDate || "-"}
                </td>
                {hasPerformanceSync && (() => {
                  const freshness = getFreshness(item);
                  return (
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] ${freshness.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${freshness.dotClass}`} />
                        {freshness.label}
                      </span>
                    </td>
                  );
                })()}
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.views?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.likes?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.comments?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.clicks?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.leads || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-sm text-foreground">
                  {item.salesAmount ? `$${item.salesAmount.toLocaleString()}` : "-"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={hasPerformanceSync ? 11 : 10} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  No content items found for the selected filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
