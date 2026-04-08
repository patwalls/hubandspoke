"use client";

import { useState } from "react";
import type { ProductionItem } from "@/types";
import { Badge } from "@/components/ui/badge";

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
      return sortDir === "asc"
        ? aVal.localeCompare(bVal)
        : bVal.localeCompare(aVal);
    }
    return sortDir === "asc"
      ? (aVal as number) - (bVal as number)
      : (bVal as number) - (aVal as number);
  });

  function SortHeader({
    label,
    sortKeyName,
  }: {
    label: string;
    sortKeyName: SortKey;
  }) {
    return (
      <th
        className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 select-none whitespace-nowrap"
        onClick={() => handleSort(sortKeyName)}
      >
        {label}
        {sortKey === sortKeyName && (
          <span className="ml-1">{sortDir === "asc" ? "\u2191" : "\u2193"}</span>
        )}
      </th>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">
          Content Performance
        </h3>
        <p className="text-sm text-gray-500">
          Individual content items with detailed metrics
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <SortHeader label="Title" sortKeyName="title" />
              <th className="px-3 py-2 text-left font-medium text-gray-600">
                Platform
              </th>
              <th className="px-3 py-2 text-left font-medium text-gray-600">
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
                className="border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="px-3 py-2 max-w-[300px]">
                  <div className="flex flex-col">
                    <span className="font-medium text-gray-900 truncate">
                      {item.publishedLink ? (
                        <a
                          href={item.publishedLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-indigo-600 hover:underline"
                        >
                          {item.title || "(Untitled)"}
                        </a>
                      ) : (
                        item.title || "(Untitled)"
                      )}
                    </span>
                    {item.utmCampaign && (
                      <span className="text-xs text-gray-400">
                        {item.utmCampaign}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {item.platform?.map((p) => (
                      <Badge key={p} variant="secondary" className="text-xs">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 text-gray-600">{item.format || "-"}</td>
                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                  {item.publishedDate || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.views?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.likes?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.comments?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.clicks?.toLocaleString() || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.leads || "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                  {item.salesAmount
                    ? `$${item.salesAmount.toLocaleString()}`
                    : "-"}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
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
