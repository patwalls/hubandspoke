"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { FilterPills } from "./filter-pills";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import type { ContentReportData } from "@/types";

const PLATFORM_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
  { key: "sales" as const, label: "Sales" },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function MATGDashboard() {
  const searchParams = useSearchParams();

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  // Report filter state
  const [startDate, setStartDate] = useState(searchParams.get("startDate") || defaultStart);
  const [endDate, setEndDate] = useState(searchParams.get("endDate") || defaultEnd);
  const [viewType, setViewType] = useState(searchParams.get("viewType") || "weekly");
  const [selectedPlatform, setSelectedPlatform] = useState(searchParams.get("platform") || "all");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "all");
  const [selectedSource, setSelectedSource] = useState(searchParams.get("source") || "all");

  // Data
  const [data, setData] = useState<ContentReportData | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  const fetchReport = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        startDate,
        endDate,
        viewType,
        platform: selectedPlatform,
        format: selectedFormat,
        source: selectedSource,
      });
      const res = await fetch(`/api/reports/matg?${params}`);
      setData(await res.json());
    } catch (err) {
      console.error("Failed to fetch data:", err);
    }
  }, [startDate, endDate, viewType, selectedPlatform, selectedFormat, selectedSource]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const currentPeriodLabel = data?.periods?.length
    ? data.periods[data.periods.length - 1]?.label
    : null;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
          Content Command Center
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Track content production across all platforms
        </p>
      </div>

      {/* Goal tiles */}
      {data ? (
        <MetricTiles
          productionData={data.byPlatform.production}
          viewsData={data.byPlatform.views}
          formatData={data.byFormat.production}
          weekProgress={data.weekProgress}
          weekStartDay={data.weekStartDay}
          currentPeriodLabel={currentPeriodLabel}
          weeklyGoal={data.weeklyGoal}
          brand="matg"
        />
      ) : (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading report...</span>
          </div>
        </div>
      )}

      {/* Filters */}
      <FilterPills
        startDate={startDate}
        endDate={endDate}
        viewType={viewType}
        selectedPlatform={selectedPlatform}
        selectedFormat={selectedFormat}
        selectedSource={selectedSource}
        platforms={data?.platforms ?? []}
        formats={data?.formats ?? []}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        onViewTypeChange={setViewType}
        onPlatformChange={setSelectedPlatform}
        onFormatChange={setSelectedFormat}
        onSourceChange={setSelectedSource}
      />

      {/* By-platform table */}
      {data && (
        <PeriodTable
          title={
            data.showingFormats
              ? "Content Production (by Format)"
              : "Content Production (by Platform)"
          }
          description="Track content created across all platforms."
          periods={data.periods}
          metrics={data.byPlatform}
          tabs={PLATFORM_TABS}
          brand="matg"
          filterKey={data.showingFormats ? "format" : "platform"}
        />
      )}
    </div>
  );
}
