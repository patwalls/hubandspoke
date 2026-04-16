"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { DateRangePicker } from "./date-range-picker";
import { Filters } from "./filters";
import { PerformanceTable } from "./performance-table";
import { getQuickRange } from "@/lib/utils/dates";
import type { ContentReportData } from "@/types";

interface ContentViewProps {
  brand: string;
}

const REPORT_API: Record<string, string> = {
  "starter-story": "/api/reports/content",
  matg: "/api/reports/matg",
};

export function ContentView({ brand }: ContentViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  const [startDate, setStartDate] = useState(searchParams.get("startDate") || defaultStart);
  const [endDate, setEndDate] = useState(searchParams.get("endDate") || defaultEnd);
  const [viewType, setViewType] = useState(searchParams.get("viewType") || "weekly");
  const [selectedPlatform, setSelectedPlatform] = useState(searchParams.get("platform") || "all");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "all");
  const [selectedSource, setSelectedSource] = useState(searchParams.get("source") || "all");

  const [data, setData] = useState<ContentReportData | null>(null);
  const [loading, setLoading] = useState(true);

  const apiBase = REPORT_API[brand] || REPORT_API["starter-story"];

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
      const res = await fetch(`${apiBase}?${params}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error("Failed to fetch content:", err);
    } finally {
      setLoading(false);
    }
  }, [apiBase, startDate, endDate, viewType, selectedPlatform, selectedFormat, selectedSource]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  function handleUpdate() {
    const params = new URLSearchParams({
      startDate,
      endDate,
      viewType,
      platform: selectedPlatform,
      format: selectedFormat,
      source: selectedSource,
    });
    router.push(`/${brand}/content?${params.toString()}`);
    fetchReport();
  }

  function handleQuickRange(range: string) {
    const result = getQuickRange(range);
    if (result) {
      setStartDate(format(result.startDate, "yyyy-MM-dd"));
      setEndDate(format(result.endDate, "yyyy-MM-dd"));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">Content</h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Browse and edit individual content items
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
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
            onPlatformChange={setSelectedPlatform}
            onFormatChange={setSelectedFormat}
            onSourceChange={setSelectedSource}
          />
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading content...</span>
          </div>
        </div>
      ) : data ? (
        <PerformanceTable
          items={data.items}
          brand={brand}
          formats={data.formats}
          onPostCreated={fetchReport}
        />
      ) : (
        <div className="text-center py-20">
          <p className="text-muted-foreground text-sm">No data available.</p>
        </div>
      )}
    </div>
  );
}
