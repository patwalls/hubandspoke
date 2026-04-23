"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { FilterPills } from "./filter-pills";
import { PerformanceTable } from "./performance-table";
import type { ContentReportData } from "@/types";
import type { PickerAccount } from "@/components/ui/account-post-type-picker";

interface ContentViewProps {
  brand: string;
}

const REPORT_API: Record<string, string> = {
  "starter-story": "/api/reports/content",
  matg: "/api/reports/matg",
};

export function ContentView({ brand }: ContentViewProps) {
  const searchParams = useSearchParams();

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  const [startDate, setStartDate] = useState(searchParams.get("startDate") || defaultStart);
  const [endDate, setEndDate] = useState(searchParams.get("endDate") || defaultEnd);
  const [viewType, setViewType] = useState(searchParams.get("viewType") || "weekly");
  const [selectedPlatformKey, setSelectedPlatformKey] = useState(searchParams.get("platformKey") || "all");
  const [selectedAccountId, setSelectedAccountId] = useState(searchParams.get("accountId") || "all");
  const [selectedPostType, setSelectedPostType] = useState(searchParams.get("postType") || "all");
  const [selectedFormat, setSelectedFormat] = useState(searchParams.get("format") || "all");
  const [selectedSource, setSelectedSource] = useState(searchParams.get("source") || "all");

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
          }>;
        };
        // Scope the Account filter dropdown to the brand we're viewing —
        // otherwise MATG's dashboard lists Starter Story accounts and vice
        // versa.
        if (!cancelled) setAccounts(json.accounts.filter((a) => a.brandSlug === brand));
      } catch {
        /* non-fatal — picker just shows empty state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brand]);

  const apiBase = REPORT_API[brand] || REPORT_API["starter-story"];

  const fetchReport = useCallback(async () => {
    setLoading(true);
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
  }, [apiBase, startDate, endDate, viewType, selectedPlatformKey, selectedAccountId, selectedPostType, selectedFormat, selectedSource]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-foreground">Content</h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Browse and edit individual content items
        </p>
      </div>

      <FilterPills
        startDate={startDate}
        endDate={endDate}
        viewType={viewType}
        selectedPlatformKey={selectedPlatformKey}
        selectedAccountId={selectedAccountId}
        selectedPostType={selectedPostType}
        selectedFormat={selectedFormat}
        selectedSource={selectedSource}
        accounts={accounts}
        formats={data?.formats ?? []}
        onStartDateChange={setStartDate}
        onEndDateChange={setEndDate}
        onViewTypeChange={setViewType}
        onPlatformKeyChange={setSelectedPlatformKey}
        onAccountChange={setSelectedAccountId}
        onPostTypeChange={setSelectedPostType}
        onFormatChange={setSelectedFormat}
        onSourceChange={setSelectedSource}
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
