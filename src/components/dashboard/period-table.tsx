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

function getCellColor(value: number, metricKey: MetricKey): string {
  if (value === 0) return "text-gray-300";
  if (metricKey === "production") {
    if (value >= 5) return "text-green-600 font-semibold";
    if (value >= 3) return "text-blue-600";
    return "text-gray-700";
  }
  return "text-gray-700";
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

  // Calculate totals per row
  const rowTotals: Record<string, number> = {};
  rows.forEach((row) => {
    const values = Object.values(data[row] || {});
    if (activeTab === "viewsPerPost") {
      const prodData = metrics["production"]?.[row] || {};
      const viewsData = metrics["views"]?.[row] || {};
      const totalProd = Object.values(prodData).reduce((a, b) => a + b, 0);
      const totalViews = Object.values(viewsData).reduce((a, b) => a + b, 0);
      rowTotals[row] = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
    } else {
      rowTotals[row] = values.reduce((a, b) => a + b, 0);
    }
  });

  // Calculate period totals (column totals)
  const periodTotals: Record<string, number> = {};
  periods.forEach((p) => {
    if (activeTab === "viewsPerPost") {
      const totalProd = rows.reduce(
        (sum, row) => sum + (metrics["production"]?.[row]?.[p.label] || 0),
        0
      );
      const totalViews = rows.reduce(
        (sum, row) => sum + (metrics["views"]?.[row]?.[p.label] || 0),
        0
      );
      periodTotals[p.label] = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
    } else {
      periodTotals[p.label] = rows.reduce(
        (sum, row) => sum + (data[row]?.[p.label] || 0),
        0
      );
    }
  });

  // Grand total
  let grandTotal: number;
  if (activeTab === "viewsPerPost") {
    const totalProd = Object.values(rowTotals).length > 0
      ? rows.reduce((sum, row) => {
          const prodData = metrics["production"]?.[row] || {};
          return sum + Object.values(prodData).reduce((a, b) => a + b, 0);
        }, 0)
      : 0;
    const totalViews = rows.reduce((sum, row) => {
      const viewsData = metrics["views"]?.[row] || {};
      return sum + Object.values(viewsData).reduce((a, b) => a + b, 0);
    }, 0);
    grandTotal = totalProd > 0 ? Math.round(totalViews / totalProd) : 0;
  } else {
    grandTotal = Object.values(rowTotals).reduce((a, b) => a + b, 0);
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-500">{description}</p>
      </div>

      <div className="px-4 py-2 border-b border-gray-100 flex gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-indigo-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="sticky left-0 bg-gray-50 px-4 py-2 text-left font-medium text-gray-600 min-w-[160px] z-10">
                Metric
              </th>
              {periods.map((p) => (
                <th
                  key={p.label}
                  className="px-3 py-2 text-center font-medium text-gray-600 min-w-[60px]"
                >
                  {p.label}
                </th>
              ))}
              <th className="px-3 py-2 text-center font-semibold text-gray-800 min-w-[70px] bg-gray-100">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row}
                className="border-b border-gray-100 hover:bg-gray-50"
              >
                <td className="sticky left-0 bg-white px-4 py-2 font-medium text-gray-800 z-10">
                  {row}
                </td>
                {periods.map((p) => {
                  const value = data[row]?.[p.label] || 0;
                  return (
                    <td
                      key={p.label}
                      className={`px-3 py-2 text-center tabular-nums ${getCellColor(value, activeTab)}`}
                    >
                      {formatValue(value, activeTab)}
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-center font-semibold text-gray-900 bg-gray-50 tabular-nums">
                  {formatValue(rowTotals[row], activeTab)}
                </td>
              </tr>
            ))}
            {/* Totals row */}
            <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
              <td className="sticky left-0 bg-gray-50 px-4 py-2 text-gray-800 z-10">
                Total
              </td>
              {periods.map((p) => (
                <td
                  key={p.label}
                  className="px-3 py-2 text-center text-gray-800 tabular-nums"
                >
                  {formatValue(periodTotals[p.label], activeTab)}
                </td>
              ))}
              <td className="px-3 py-2 text-center text-gray-900 bg-gray-100 tabular-nums">
                {formatValue(grandTotal, activeTab)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
