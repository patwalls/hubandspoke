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

export function PerformanceTable({ items }: PerformanceTableProps) {
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
                <td className="px-3 py-2 max-w-[200px] sm:max-w-[280px]">
                  <div className="flex flex-col gap-0.5">
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
                <td colSpan={10} className="px-4 py-12 text-center text-muted-foreground text-sm">
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
