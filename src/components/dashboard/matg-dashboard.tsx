"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { format, subDays } from "date-fns";
import { FilterPills, type FilterAccount } from "./filter-pills";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import type { ContentReportData } from "@/types";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useRememberListUrl } from "@/lib/hooks/use-remember-list-url";

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
  // Rolling 90-day default; memoized so the hook's default-pruning sees a
  // stable string per render.
  const { defaultStart, defaultEnd } = useMemo(() => {
    const today = new Date();
    return {
      defaultStart: format(subDays(today, 90), "yyyy-MM-dd"),
      defaultEnd: format(today, "yyyy-MM-dd"),
    };
  }, []);

  const filters = useUrlState({
    platform: { default: "all" },
    accountId: { default: "all" },
    postType: { default: "all" },
    format: { default: "all" },
    source: { default: "all" },
    origin: { default: "all" },
    provenOnly: { default: "0" },
    startDate: { default: defaultStart },
    endDate: { default: defaultEnd },
    viewType: { default: "weekly" },
  });
  const {
    platform: selectedPlatformKey,
    accountId: selectedAccountId,
    postType: selectedPostType,
    format: selectedFormat,
    source: selectedSource,
    origin: selectedOrigin,
    provenOnly: provenOnlyFlag,
    startDate,
    endDate,
    viewType,
  } = filters.values;
  const provenOnly = provenOnlyFlag === "1";

  useRememberListUrl({ brand: "matg", listKey: "dashboard" });

  // Data
  const [data, setData] = useState<ContentReportData | null>(null);
  const [accounts, setAccounts] = useState<FilterAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts");
        if (!res.ok) return;
        const json = (await res.json()) as { accounts: FilterAccount[] };
        // MATG dashboard — only show MATG accounts in the filter dropdown.
        if (!cancelled) {
          setAccounts(json.accounts.filter((a) => a.brandSlug === "matg"));
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Data fetching                                                    */
  /* ---------------------------------------------------------------- */

  const fetchReport = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        startDate,
        endDate,
        viewType,
        platformKey: selectedPlatformKey,
        accountId: selectedAccountId,
        postType: selectedPostType,
        format: selectedFormat,
        source: selectedSource,
        origin: selectedOrigin,
        provenOnly: provenOnly ? "1" : "0",
      });
      const res = await fetch(`/api/reports/matg?${params}`);
      setData(await res.json());
    } catch (err) {
      console.error("Failed to fetch data:", err);
    }
  }, [startDate, endDate, viewType, selectedPlatformKey, selectedAccountId, selectedPostType, selectedFormat, selectedSource, selectedOrigin, provenOnly]);

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
          weeklyViewsGoal={data.weeklyViewsGoal}
          brand="matg"
          provenSummary={data.provenSummary}
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
        selectedPlatformKey={selectedPlatformKey}
        selectedAccountId={selectedAccountId}
        selectedPostType={selectedPostType}
        selectedFormat={selectedFormat}
        selectedSource={selectedSource}
        selectedOrigin={selectedOrigin}
        provenOnly={provenOnly}
        accounts={accounts}
        formats={data?.formats ?? []}
        onStartDateChange={(v) => filters.set("startDate", v)}
        onEndDateChange={(v) => filters.set("endDate", v)}
        onViewTypeChange={(v) => filters.set("viewType", v)}
        onPlatformKeyChange={(v) => filters.set("platform", v)}
        onAccountChange={(v) => filters.set("accountId", v)}
        onPostTypeChange={(v) => filters.set("postType", v)}
        onFormatChange={(v) => filters.set("format", v)}
        onSourceChange={(v) => filters.set("source", v)}
        onOriginChange={(v) => filters.set("origin", v)}
        onProvenOnlyChange={(v) => filters.set("provenOnly", v ? "1" : "0")}
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
          rowMeta={data.showingFormats ? undefined : data.primaryRowMeta}
        />
      )}
    </div>
  );
}
