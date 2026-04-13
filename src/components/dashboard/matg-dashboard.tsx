"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { format, subDays } from "date-fns";
import { DateRangePicker } from "./date-range-picker";
import { Filters } from "./filters";
import { MetricTiles } from "./metric-tiles";
import { PeriodTable } from "./period-table";
import { PerformanceTable } from "./performance-table";
import { getQuickRange } from "@/lib/utils/dates";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ContentReportData } from "@/types";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FormatRow {
  id: string;
  name: string;
  channels: string[];
  event: string | null;
  viewThreshold: number | null;
  contentOwner: string | null;
  contentOwnerAsanaGid: string | null;
  instructions: string | null;
  contentType: string | null;
  repurposeTargetIds: string[];
}

interface TriggerResult {
  sourceFormat: string;
  tasksCreated: { formatName: string; asanaGid: string; assignee?: string }[];
}

interface SyncResult {
  videosFetched: number;
  created: number;
  updated: number;
  errors: number;
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

const FORMAT_TABS = [
  { key: "production" as const, label: "Production" },
  { key: "views" as const, label: "Views" },
  { key: "leads" as const, label: "Leads" },
  { key: "viewsPerPost" as const, label: "Views Per Post" },
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
  const router = useRouter();
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
  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Sync
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<LastSyncInfo | null>(null);

  // Trigger
  const [triggering, setTriggering] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TriggerResult | null>(null);

  // Tabs
  const [activeTab, setActiveTab] = useState<"report" | "pipeline">("report");

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

      const [reportRes, formatsRes, syncInfoRes] = await Promise.all([
        fetch(`/api/reports/matg?${params}`),
        fetch("/api/formats?brand=matg"),
        fetch("/api/sync/youtube"),
      ]);
      const reportData = await reportRes.json();
      const formatsData = await formatsRes.json();
      const syncInfoData = await syncInfoRes.json();

      setData(reportData);
      setFormats(formatsData);
      setLastSync(syncInfoData.lastSync || null);
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

  const pillarFormats = formats.filter((f) => (f.contentType || "pillar") === "pillar");
  const spokeFormats = formats.filter((f) => f.contentType === "repurposed");

  function handleUpdate() {
    const params = new URLSearchParams({
      startDate,
      endDate,
      viewType,
      platform: selectedPlatform,
      format: selectedFormat,
      source: selectedSource,
    });
    router.push(`/matg?${params.toString()}`);
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

  async function handleTrigger(formatId: string, videoTitle?: string, views?: number) {
    setTriggering(formatId);
    setLastResult(null);
    try {
      const res = await fetch("/api/trigger-repurpose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formatId,
          videoTitle: videoTitle || "Business Interview Episode",
          views: views || 0,
        }),
      });
      const result = await res.json();
      setLastResult(result);
    } catch (err) {
      console.error("Trigger failed:", err);
    } finally {
      setTriggering(null);
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
            🎙️ MATG Content Command Center
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Track content production &amp; repurpose pipeline
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSync?.completedAt && (
            <span className="text-xs text-muted-foreground">
              Last synced {timeAgo(lastSync.completedAt)}
            </span>
          )}
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
                Sync from YouTube
              </>
            )}
          </button>
        </div>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          Synced {syncResult.videosFetched} videos — {syncResult.created} new, {syncResult.updated} updated
          {syncResult.errors > 0 && `, ${syncResult.errors} errors`}
        </div>
      )}

      {/* Sync cooldown message */}
      {syncMessage && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-center gap-2">
          <span>⏳</span>
          {syncMessage}
        </div>
      )}

      {/* Asana trigger result banner */}
      {lastResult && lastResult.tasksCreated.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
          <div className="flex items-center gap-2 text-green-800 font-medium text-sm">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>
            Created {lastResult.tasksCreated.length} Asana tasks from &ldquo;{lastResult.sourceFormat}&rdquo;
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lastResult.tasksCreated.map((t) => (
              <Badge key={t.asanaGid} variant="secondary" className="text-xs bg-green-100 text-green-800">
                {t.formatName}
                {t.assignee && ` → ${t.assignee}`}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab("report")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "report"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          📊 Content Report
        </button>
        <button
          onClick={() => setActiveTab("pipeline")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "pipeline"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          🔄 Repurpose Pipeline
        </button>
      </div>

      {/* ============================================================ */}
      {/*  Content Report Tab (matches Starter Story)                   */}
      {/* ============================================================ */}
      {activeTab === "report" && (
        <div className="space-y-6">
          {/* Controls */}
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
                <span className="text-sm">Loading report...</span>
              </div>
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
                description="Track content created across all platforms."
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
            <div className="text-center py-20">
              <p className="text-muted-foreground text-sm">
                No data available. Try syncing from YouTube.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/*  Repurpose Pipeline Tab                                       */}
      {/* ============================================================ */}
      {activeTab === "pipeline" && (
        <div className="space-y-4">
          {pillarFormats.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-muted-foreground">
              No pillar formats yet. Create one on the Formats page to get started.
            </div>
          ) : (
            pillarFormats.map((pillar) => {
              const targets = (pillar.repurposeTargetIds || [])
                .map((id) => formats.find((f) => f.id === id))
                .filter(Boolean) as FormatRow[];

              return (
                <div key={pillar.id} className="rounded-lg border border-border bg-card overflow-hidden">
                  <div className="bg-blue-50 border-b border-blue-100 px-4 sm:px-6 py-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">🎯</span>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-foreground">{pillar.name}</h3>
                            <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">Hub</Badge>
                          </div>
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {pillar.channels?.map((ch) => (
                              <span key={ch} className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">{ch}</span>
                            ))}
                          </div>
                          {pillar.viewThreshold && (
                            <p className="text-xs text-muted-foreground mt-1.5">
                              Triggers at <span className="font-medium text-foreground">{pillar.viewThreshold.toLocaleString()} views</span>
                            </p>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleTrigger(pillar.id)}
                        disabled={triggering === pillar.id || targets.length === 0}
                        className="whitespace-nowrap"
                      >
                        {triggering === pillar.id ? "Creating..." : `Trigger Repurpose (${targets.length})`}
                      </Button>
                    </div>
                  </div>
                  {targets.length > 0 ? (
                    <div className="divide-y divide-border/50">
                      {targets.map((spoke) => (
                        <div key={spoke.id} className="px-4 sm:px-6 py-3 flex items-center gap-3 hover:bg-accent/30 transition-colors">
                          <span className="text-lg">🔄</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-foreground">{spoke.name}</span>
                              <Badge variant="outline" className="text-[10px] border-purple-200 text-purple-600">Spoke</Badge>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {spoke.channels?.map((ch) => (
                                <span key={ch} className="text-[11px] text-muted-foreground">{ch}</span>
                              ))}
                            </div>
                          </div>
                          {spoke.contentOwner && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-medium">
                                {spoke.contentOwner.split(" ").map(n => n[0]).join("").slice(0, 2)}
                              </span>
                              <span className="text-xs text-muted-foreground hidden sm:inline">{spoke.contentOwner}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-6 py-4 text-sm text-muted-foreground text-center">
                      No repurpose targets configured.
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Unconnected spokes */}
          {(() => {
            const connectedSpokeIds = new Set(
              pillarFormats.flatMap((p) => p.repurposeTargetIds || [])
            );
            const unconnectedSpokes = spokeFormats.filter(
              (f) => !connectedSpokeIds.has(f.id)
            );
            if (unconnectedSpokes.length === 0) return null;
            return (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-xs text-amber-700 mb-2">
                  These spoke formats aren&apos;t connected to any pillar:
                </p>
                <div className="flex flex-wrap gap-2">
                  {unconnectedSpokes.map((f) => (
                    <Badge key={f.id} variant="outline" className="text-xs border-amber-300 text-amber-700">
                      {f.name}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
