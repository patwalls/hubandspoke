"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { FilterPills } from "./filter-pills";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import type { ContentReportData } from "@/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SourceResult {
  source: string;
  fetched: number;
  created: number;
  updated: number;
  errors: number;
}

interface SyncResult {
  sources?: SourceResult[];
  totalFetched?: number;
  totalCreated?: number;
  totalUpdated?: number;
  totalErrors?: number;
  creditsUsed?: number;
  // Legacy single-source fields
  videosFetched?: number;
  created?: number;
  updated?: number;
  errors?: number;
}

interface PerfSyncResult {
  creditsUsed: number;
  itemsUpdated: number;
  shortsUpdated: number;
  videosUpdated: number;
  individualFetches: number;
  byTier: Record<string, number>;
  skippedReason?: string;
}

interface PerformanceDue {
  totalDue: number;
  byTier: Record<string, number>;
}

interface LastSyncInfo {
  status: string;
  startedAt: string;
  completedAt: string | null;
  itemsFetched: number | null;
  itemsCreated: number | null;
  itemsUpdated: number | null;
}

const PLATFORM_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
  { key: "sales" as const, label: "Sales" },
];

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

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
  const [, setLoading] = useState(true);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<LastSyncInfo | null>(null);

  // Performance sync
  const [perfSyncing, setPerfSyncing] = useState(false);
  const [perfResult, setPerfResult] = useState<PerfSyncResult | null>(null);
  const [performanceDue, setPerformanceDue] = useState<PerformanceDue | null>(null);

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

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

      const [reportRes, syncInfoRes] = await Promise.all([
        fetch(`/api/reports/matg?${params}`),
        fetch("/api/sync/youtube"),
      ]);
      const reportData = await reportRes.json();
      const syncInfoData = await syncInfoRes.json();

      setData(reportData);
      setLastSync(syncInfoData.lastSync || null);
      setPerformanceDue(syncInfoData.performanceDue || null);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, viewType, selectedPlatform, selectedFormat, selectedSource]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/sync/youtube", { method: "POST" });
      const result = await res.json();

      if (result.skipped) {
        setSyncMessage(result.message);
      } else {
        setSyncResult(result);
        await fetchReport();
      }
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncing(false);
    }
  }

  async function handlePerfSync() {
    setPerfSyncing(true);
    setPerfResult(null);
    try {
      const res = await fetch("/api/sync/youtube?mode=performance", { method: "POST" });
      const result = await res.json();
      setPerfResult(result);
      if (result.itemsUpdated > 0) {
        await fetchReport();
      }
    } catch (err) {
      console.error("Performance sync failed:", err);
    } finally {
      setPerfSyncing(false);
    }
  }

  const currentPeriodLabel = data?.periods?.length
    ? data.periods[data.periods.length - 1]?.label
    : null;

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Content Command Center
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Track content production across all platforms
          </p>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {lastSync?.completedAt && (
            <span className="text-xs text-muted-foreground">
              Last synced {timeAgo(lastSync.completedAt)}
            </span>
          )}
          <button
            onClick={handlePerfSync}
            disabled={perfSyncing}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 sm:py-1.5 text-sm font-medium rounded-md border border-border bg-card text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {perfSyncing ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Updating...
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                </svg>
                Update Performance
                {performanceDue && performanceDue.totalDue > 0 && (
                  <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                    {performanceDue.totalDue} due
                  </span>
                )}
              </>
            )}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 sm:py-1.5 text-sm font-medium rounded-md border border-border bg-card text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            {syncing ? (
              <>
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Syncing...
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                Full Sync
              </>
            )}
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          {syncResult.sources ? (
            <div className="space-y-1">
              <div className="font-medium">
                Synced {syncResult.totalFetched} items — {syncResult.totalCreated} new, {syncResult.totalUpdated} updated
                {(syncResult.totalErrors || 0) > 0 && `, ${syncResult.totalErrors} errors`}
                {` (${syncResult.creditsUsed} credits used)`}
              </div>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {syncResult.sources.map((s) => (
                  <span key={s.source} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">
                    {s.source}: {s.fetched} items
                    {s.errors > 0 && <span className="text-amber-600">({s.errors} err)</span>}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <>
              Synced {syncResult.videosFetched} videos — {syncResult.created} new, {syncResult.updated} updated
              {(syncResult.errors || 0) > 0 && `, ${syncResult.errors} errors`}
            </>
          )}
        </div>
      )}

      {/* Performance sync result banner */}
      {perfResult && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800">
          {perfResult.skippedReason ? (
            <span>✓ {perfResult.skippedReason}</span>
          ) : (
            <div className="space-y-1">
              <div className="font-medium">
                Performance updated: {perfResult.itemsUpdated} items
                {perfResult.individualFetches > 0 && ` (${perfResult.individualFetches} detailed)`}
                {` — ${perfResult.creditsUsed} credit${perfResult.creditsUsed !== 1 ? "s" : ""} used`}
              </div>
              {Object.keys(perfResult.byTier).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {Object.entries(perfResult.byTier).map(([tier, count]) => (
                    <span key={tier} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700">
                      {tier}: {count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Sync cooldown message */}
      {syncMessage && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-center gap-2">
          <span>⏳</span>
          {syncMessage}
        </div>
      )}

      {/* Goal tiles */}
      {data ? (
        <MetricTiles
          productionData={data.byPlatform.production}
          viewsData={data.byPlatform.views}
          formatData={data.byFormat.production}
          weekProgress={data.weekProgress}
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
