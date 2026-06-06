"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { format, subDays } from "date-fns";
import { FilterPills, type FilterAccount } from "./filter-pills";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import type { ContentReportData } from "@/types";
import { todayInclusiveOfUtc } from "@/lib/dates";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useRememberListUrl } from "@/lib/hooks/use-remember-list-url";

const PLATFORM_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
];

export function ContentReport({ brand }: { brand: string }) {
  const { defaultStart, defaultEnd } = useMemo(() => {
    const today = new Date();
    return {
      defaultStart: format(subDays(today, 90), "yyyy-MM-dd"),
      defaultEnd: todayInclusiveOfUtc(),
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

  useRememberListUrl({ brand, listKey: "dashboard" });

  const [data, setData] = useState<ContentReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Accounts for the new Account dropdown. Fetched once per mount; the
  // picker's cascade logic inside FilterPills filters them by platform.
  const [accounts, setAccounts] = useState<FilterAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts");
        if (!res.ok) return;
        const json = (await res.json()) as {
          accounts: Array<{
            id: string;
            platform: string;
            handle: string;
            avatarUrl: string | null;
            brandSlug: string;
            brandLabel: string;
          }>;
        };
        // Scope the account dropdown to the brand this dashboard is rendering.
        // `brand === "all"` is the cross-brand /all view — show every account
        // so the picker isn't empty.
        if (!cancelled) {
          setAccounts(
            brand === "all"
              ? json.accounts
              : json.accounts.filter((a) => a.brandSlug === brand)
          );
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({
        brand,
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
      const res = await fetch(`/api/reports/content?${params}`);
      const text = await res.text();
      const contentType = res.headers.get("content-type") || "";
      const looksJson = contentType.includes("application/json") || text.trim().startsWith("{");

      if (!looksJson) {
        // Typical cause: Heroku / router HTML error page (timeout, 503, auth redirect).
        setData(null);
        setFetchError(
          `Report API returned HTTP ${res.status} (non-JSON response). The server likely timed out or crashed — try Retry in a moment.`
        );
        return;
      }

      let json: { error?: string; byPlatform?: unknown } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        setData(null);
        setFetchError(`Report API returned HTTP ${res.status} with malformed JSON.`);
        return;
      }

      if (!res.ok || !json?.byPlatform) {
        setData(null);
        setFetchError(json?.error || `Report API returned HTTP ${res.status}`);
        return;
      }
      setData(json as ContentReportData);
    } catch (err) {
      console.error("Failed to fetch report:", err);
      setFetchError(err instanceof Error ? err.message : "Failed to fetch report");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [brand, startDate, endDate, viewType, selectedPlatformKey, selectedAccountId, selectedPostType, selectedFormat, selectedSource, selectedOrigin, provenOnly]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const currentPeriodLabel = data?.periods?.length
    ? data.periods[data.periods.length - 1]?.label
    : null;

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

      {/* Error banner */}
      {fetchError && !loading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="font-medium">Failed to load dashboard data</div>
          <div className="mt-0.5 text-xs break-words">{fetchError}</div>
          <button
            onClick={() => fetchReport()}
            className="mt-2 text-xs underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Goal tiles — show first */}
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
          brand={brand}
          weekOverWeek={data.weekOverWeek}
          provenSummary={data.provenSummary}
        />
      ) : !fetchError ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-2 text-muted-foreground">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading report...</span>
          </div>
        </div>
      ) : null}

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
        onDateRangeChange={(s, e) => filters.setMany({ startDate: s, endDate: e })}
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
      {data ? (
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
          brand={brand}
          filterKey={data.showingFormats ? "format" : "platform"}
          rowMeta={data.showingFormats ? undefined : data.primaryRowMeta}
        />
      ) : !loading ? (
        <div className="text-center py-20">
          <p className="text-muted-foreground text-sm">
            No data available. Try syncing from Notion.
          </p>
        </div>
      ) : null}
    </div>
  );
}
