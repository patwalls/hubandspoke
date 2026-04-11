"use client";

import { useState } from "react";
import type { MetricData, Period } from "@/types";

type MetricKey = "production" | "views" | "leads" | "viewsPerPost" | "sales";

interface PeriodTableProps {
  title: string;
  description: string;
  periods: Period[];
  metrics: Record<string, MetricData>;
  tabs: { key: MetricKey; label: string }[];
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
}: PeriodTableProps) {
  const [activeTab, setActiveTab] = useState<MetricKey>(tabs[0].key);

  const data = metrics[activeTab] || {};
  const rows = Object.keys(data).sort();

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
              <th className="sticky left-0 bg-accent/50 px-3 sm:px-4 py-2.5 text-left font-medium text-muted-foreground min-w-[120px] sm:min-w-[180px] z-10 font-mono uppercase tracking-wider text-[10px]">
                Metric
              </th>
              {periods.map((p) => (
                <th
                  key={p.label}
                  className="px-2 py-2.5 text-center font-medium text-muted-foreground min-w-[52px] font-mono uppercase tracking-wider text-[10px]"
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
            {rows.map((row) => (
              <tr
                key={row}
                className="border-b border-border/50 hover:bg-accent/30 transition-colors"
              >
                <td className="sticky left-0 bg-card px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium text-foreground z-10">
                  {row}
                </td>
                {periods.map((p) => {
                  const value = data[row]?.[p.label] || 0;
                  return (
                    <td
                      key={p.label}
                      className={`px-2 py-2 text-center tabular-nums ${
                        value === 0
                          ? "text-border"
                          : "text-foreground"
                      }`}
                    >
                      {formatValue(value, activeTab)}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-center font-semibold text-foreground bg-accent/30 tabular-nums">
                  {formatValue(rowTotals[row], activeTab)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-border bg-accent/50 font-semibold">
              <td className="sticky left-0 bg-accent/50 px-3 sm:px-4 py-2 text-xs sm:text-sm text-foreground z-10 font-mono uppercase tracking-wider text-[10px]">
                Total
              </td>
              {periods.map((p) => (
                <td
                  key={p.label}
                  className="px-2 py-2 text-center text-foreground tabular-nums"
                >
                  {formatValue(periodTotals[p.label], activeTab)}
                </td>
              ))}
              <td className="px-3 py-2 text-center text-foreground bg-accent tabular-nums">
                {formatValue(grandTotal, activeTab)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
