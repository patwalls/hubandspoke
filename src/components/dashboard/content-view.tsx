"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { format, subDays } from "date-fns";
import { FilterPills, SelectPill } from "./filter-pills";
import { PerformanceTable } from "./performance-table";
import type { ContentReportData } from "@/types";
import type { PickerAccount } from "@/components/ui/account-post-type-picker";
import { todayInclusiveOfUtc } from "@/lib/dates";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useRememberListUrl } from "@/lib/hooks/use-remember-list-url";
import { BangersView } from "./bangers-view";

interface ContentViewProps {
  brand: string;
}

// MATG has a legacy bespoke endpoint that hard-codes its brand slug and
// does its own weekly-goal math. Every other brand goes through the
// generic report endpoint, which takes `brand` as a query param. The old
// fallback to `/api/reports/content` without a brand param meant any new
// brand (e.g. my-first-million) silently showed Starter Story content.
const LEGACY_REPORT_API: Record<string, string> = {
  matg: "/api/reports/matg",
};

export function ContentView({ brand }: ContentViewProps) {
  // Default date range is a rolling 90 days back from "today". Memoize so
  // the hook's default-pruning sees a stable string per render (the wall
  // clock only ticks across midnight; pruning a value that matches today's
  // default but won't match tomorrow's is a fair trade-off — see
  // use-url-state.ts notes).
  const { defaultStart, defaultEnd } = useMemo(() => {
    const today = new Date();
    return {
      defaultStart: format(subDays(today, 90), "yyyy-MM-dd"),
      defaultEnd: todayInclusiveOfUtc(),
    };
  }, []);

  // Dashboard drill-through links build URLs with `?platform=<row-label>`,
  // which has always been the canonical URL key. The hook reads it
  // directly. (A legacy alias `?platformKey=` was accepted by the
  // pre-2026-05-22 hand-rolled seeding; not worth carrying forward — the
  // alias only fired on first mount and Dashboard always used `platform`.)
  const filters = useUrlState({
    view: { default: "list" },
    platform: { default: "all" },
    accountId: { default: "all" },
    postType: { default: "all" },
    format: { default: "all" },
    source: { default: "all" },
    origin: { default: "all" },
    startDate: { default: defaultStart },
    endDate: { default: defaultEnd },
    viewType: { default: "weekly" },
  });
  const {
    view: activeView,
    platform: selectedPlatformKey,
    accountId: selectedAccountId,
    postType: selectedPostType,
    format: selectedFormat,
    source: selectedSource,
    origin: selectedOrigin,
    startDate,
    endDate,
    viewType,
  } = filters.values;

  // Persist the URL so the detail page's `<BackLink listKey="content">`
  // can land the user back here with filters intact.
  useRememberListUrl({ brand, listKey: "content" });

  const [data, setData] = useState<ContentReportData | null>(null);
  const [loading, setLoading] = useState(true);
  // Fetched once per mount — the create-item dialog's account picker reads
  // this. Kept narrow (no filtering yet); add-form picker filters by
  // `brandSlug` prop so all-brand fetch is fine.
  const [accounts, setAccounts] = useState<PickerAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/accounts");
        if (!res.ok) return;
        const json = (await res.json()) as {
          accounts: Array<{
            id: string;
            brandSlug: string;
            brandLabel: string;
            platform: string;
            handle: string;
            displayName: string | null;
            avatarUrl: string | null;
            isActive: boolean;
            syncedFromNotion: boolean;
          }>;
        };
        // Scope the Account filter dropdown to the brand we're viewing —
        // otherwise MATG's dashboard lists Starter Story accounts and vice
        // versa. `brand === "all"` is the cross-brand /all view; show every
        // account in that case so the picker isn't empty.
        if (!cancelled) {
          setAccounts(
            brand === "all"
              ? json.accounts
              : json.accounts.filter((a) => a.brandSlug === brand)
          );
        }
      } catch {
        /* non-fatal — picker just shows empty state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brand]);

  // The cross-brand /all view never uses the MATG-specific endpoint, even
  // though "matg" is a real brand slug — `brand === "all"` falls through to
  // the generic report endpoint and the queries.ts side handles the
  // no-filter aggregation.
  const apiBase = brand === "all"
    ? "/api/reports/content"
    : LEGACY_REPORT_API[brand] ?? "/api/reports/content";

  const fetchReport = useCallback(async () => {
    setLoading(true);
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
        ...(activeView === "duplicates" ? { special: "duplicates" } : {}),
      });
      const res = await fetch(`${apiBase}?${params}`);
      const text = await res.text();
      const contentType = res.headers.get("content-type") || "";
      const looksJson = contentType.includes("application/json") || text.trim().startsWith("{");
      if (!looksJson) {
        console.error(`Content API returned HTTP ${res.status} (non-JSON response).`);
        setData(null);
        return;
      }
      const json = JSON.parse(text);
      setData(json);
    } catch (err) {
      console.error("Failed to fetch content:", err);
    } finally {
      setLoading(false);
    }
  }, [apiBase, brand, startDate, endDate, viewType, selectedPlatformKey, selectedAccountId, selectedPostType, selectedFormat, selectedSource, selectedOrigin, activeView]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">Content</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Browse and edit individual content items
          </p>
        </div>
        <SelectPill
          label="Other"
          value={activeView === "bangers" || activeView === "duplicates" ? activeView : "list"}
          options={[
            { value: "list", label: "All content" },
            { value: "bangers", label: "Top Bangers" },
            { value: "duplicates", label: "Potential duplicates" },
          ]}
          onChange={(v) => filters.set("view", v)}
        />
      </div>

      {activeView === "bangers" ? (
        <BangersView brand={brand} accounts={accounts} />
      ) : (
      <>
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
        accounts={accounts}
        formats={data?.formats ?? []}
        showViewType={false}
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
      />

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
          accounts={accounts}
          formatBars={data.formatBars}
          onPostCreated={fetchReport}
        />
      ) : (
        <div className="text-center py-20">
          <p className="text-muted-foreground text-sm">No data available.</p>
        </div>
      )}
      </>
      )}
    </div>
  );
}
