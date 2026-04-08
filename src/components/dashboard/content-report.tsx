"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { DateRangePicker } from "./date-range-picker";
import { Filters } from "./filters";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import { PerformanceTable } from "./performance-table";
import { Button } from "@/components/ui/button";
import { getQuickRange } from "@/lib/utils/dates";
import type { ContentReportData } from "@/types";

const PLATFORM_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
  { key: "sales" as const, label: "Sales" },
];

const FORMAT_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
];

export function ContentReport() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  const [startDate, setStartDate] = useState(
    searchParams.get("startDate") || defaultStart
  );
  const [endDate, setEndDate] = useState(
    searchParams.get("endDate") || defaultEnd
  );
  const [viewType, setViewType] = useState(
    searchParams.get("viewType") || "weekly"
  );
  const [selectedPlatform, setSelectedPlatform] = useState(
    searchParams.get("platform") || "all"
  );
  const [selectedFormat, setSelectedFormat] = useState(
    searchParams.get("format") || "all"
  );
  const [selectedSource, setSelectedSource] = useState(
    searchParams.get("source") || "all"
  );

  const [data, setData] = useState<ContentReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        startDate,
        endDate,
        viewType,
        platform: selectedPlatform,
        format: selectedFormat,
        source: selectedSource,
      });
      const res = await fetch(`/api/reports/content?${params}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch report:", err);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, viewType, selectedPlatform, selectedFormat, selectedSource]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  function updateUrl() {
    const params = new URLSearchParams({
      startDate,
      endDate,
      viewType,
      platform: selectedPlatform,
      format: selectedFormat,
      source: selectedSource,
    });
    router.push(`/?${params.toString()}`);
  }

  function handleUpdate() {
    updateUrl();
    fetchReport();
  }

  function handleQuickRange(range: string) {
    const result = getQuickRange(range);
    if (result) {
      setStartDate(format(result.startDate, "yyyy-MM-dd"));
      setEndDate(format(result.endDate, "yyyy-MM-dd"));
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/sync/notion", { method: "POST" });
      const result = await res.json();
      if (result.success) {
        await fetchReport();
      } else {
        console.error("Sync failed:", result.error);
      }
    } catch (err) {
      console.error("Sync error:", err);
    } finally {
      setSyncing(false);
    }
  }

  // Find the current period label (last period that includes today)
  const currentPeriodLabel = data?.periods?.length
    ? data.periods[data.periods.length - 1]?.label
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">
          Content Command Center
        </h1>
        <Button
          onClick={handleSync}
          disabled={syncing}
          variant="outline"
          size="sm"
        >
          {syncing ? "Syncing..." : "Sync from Notion"}
        </Button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          viewType={viewType}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onViewTypeChange={setViewType}
          onUpdate={handleUpdate}
          onQuickRange={handleQuickRange}
        />
        {data && (
          <Filters
            platforms={data.platforms}
            formats={data.formats}
            selectedPlatform={selectedPlatform}
            selectedFormat={selectedFormat}
            selectedSource={selectedSource}
            onPlatformChange={(p) => {
              setSelectedPlatform(p);
            }}
            onFormatChange={(f) => {
              setSelectedFormat(f);
            }}
            onSourceChange={(s) => {
              setSelectedSource(s);
            }}
          />
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-400">Loading report...</div>
        </div>
      ) : data ? (
        <>
          <MetricTiles
            productionData={data.byPlatform.production}
            weekProgress={data.weekProgress}
            currentPeriodLabel={currentPeriodLabel}
            weeklyGoal={77}
          />

          <PeriodTable
            title={
              data.showingFormats
                ? "Content Production (by Format)"
                : "Content Production (by Platform)"
            }
            description="Track content created across all platforms. Weekly goal: 77 posts."
            periods={data.periods}
            metrics={data.byPlatform}
            tabs={PLATFORM_TABS}
          />

          {!data.showingFormats && (
            <PeriodTable
              title="Content by Format"
              description="Content production broken down by format type."
              periods={data.periods}
              metrics={data.byFormat}
              tabs={FORMAT_TABS}
            />
          )}

          <PerformanceTable items={data.items} />
        </>
      ) : (
        <div className="text-center py-20 text-gray-400">
          No data available. Try syncing from Notion.
        </div>
      )}
    </div>
  );
}
