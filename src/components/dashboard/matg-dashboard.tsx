"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

interface VideoItem {
  id: string;
  title: string;
  youtubeId: string | null;
  youtubeUrl: string | null;
  thumbnail: string | null;
  publishedDate: string | null;
  views: number | null;
  status: string | null;
}

interface MATGReport {
  items: VideoItem[];
  stats: {
    totalVideos: number;
    totalViews: number;
    avgViews: number;
  };
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

export function MATGDashboard() {
  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [report, setReport] = useState<MATGReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TriggerResult | null>(null);
  const [activeTab, setActiveTab] = useState<"content" | "pipeline">("content");

  const fetchData = useCallback(async () => {
    try {
      const [formatsRes, reportRes] = await Promise.all([
        fetch("/api/formats?brand=matg"),
        fetch("/api/reports/matg"),
      ]);
      const formatsData = await formatsRes.json();
      const reportData = await reportRes.json();
      setFormats(formatsData);
      setReport(reportData);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const pillarFormats = formats.filter((f) => (f.contentType || "pillar") === "pillar");
  const spokeFormats = formats.filter((f) => f.contentType === "repurposed");

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/youtube", { method: "POST" });
      const data = await res.json();
      setSyncResult(data);
      // Refresh report data
      const reportRes = await fetch("/api/reports/matg");
      const reportData = await reportRes.json();
      setReport(reportData);
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
      const data = await res.json();
      setLastResult(data);
    } catch (err) {
      console.error("Trigger failed:", err);
    } finally {
      setTriggering(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading...
      </div>
    );
  }

  const stats = report?.stats || { totalVideos: 0, totalViews: 0, avgViews: 0 };
  const videos = report?.items || [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            🎙️ MATG Dashboard
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-1">
            Content performance &amp; repurpose pipeline
          </p>
        </div>
        <Button
          onClick={handleSync}
          disabled={syncing}
          variant="outline"
          size="sm"
        >
          {syncing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              Syncing YouTube...
            </span>
          ) : (
            "🔄 Sync YouTube Data"
          )}
        </Button>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          Synced {syncResult.videosFetched} videos — {syncResult.created} new, {syncResult.updated} updated
          {syncResult.errors > 0 && `, ${syncResult.errors} errors`}
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

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.totalVideos}</div>
          <div className="text-xs text-gray-500 mt-1">Total Videos</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">{stats.totalViews.toLocaleString()}</div>
          <div className="text-xs text-gray-500 mt-1">Total Views</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">{stats.avgViews.toLocaleString()}</div>
          <div className="text-xs text-gray-500 mt-1">Avg Views</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-purple-600">
            {pillarFormats.reduce((sum, f) => sum + (f.repurposeTargetIds?.length || 0), 0)}
          </div>
          <div className="text-xs text-gray-500 mt-1">Repurpose Chains</div>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab("content")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "content"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          📊 Content Performance
        </button>
        <button
          onClick={() => setActiveTab("pipeline")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "pipeline"
              ? "border-gray-900 text-gray-900"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          🔄 Repurpose Pipeline
        </button>
      </div>

      {/* Content Performance Tab */}
      {activeTab === "content" && (
        <div className="space-y-4">
          {videos.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
              <p className="text-gray-400 mb-3">No videos synced yet.</p>
              <Button onClick={handleSync} disabled={syncing} size="sm">
                {syncing ? "Syncing..." : "Sync YouTube Data"}
              </Button>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden sm:block bg-white rounded-lg border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="px-4 py-3 text-left font-medium text-gray-600">Video</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-600">Published</th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">Views</th>
                      <th className="px-4 py-3 text-right font-medium text-gray-600">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videos.map((v) => {
                      // Check if any pillar format threshold is crossed
                      const thresholdCrossed = pillarFormats.find(
                        (f) => f.viewThreshold && (v.views || 0) >= f.viewThreshold
                      );

                      return (
                        <tr key={v.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              {v.thumbnail && (
                                <img
                                  src={v.thumbnail}
                                  alt=""
                                  className="w-24 h-14 rounded object-cover shrink-0"
                                />
                              )}
                              <div className="min-w-0">
                                <a
                                  href={v.youtubeUrl || "#"}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-gray-900 hover:text-blue-600 line-clamp-2"
                                >
                                  {v.title}
                                </a>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{v.publishedDate || "-"}</td>
                          <td className="px-4 py-3 text-right font-medium text-gray-900">
                            {(v.views || 0).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {thresholdCrossed ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-xs border-green-300 text-green-700 hover:bg-green-50"
                                onClick={() => handleTrigger(thresholdCrossed.id, v.title || undefined, v.views || 0)}
                                disabled={triggering === thresholdCrossed.id}
                              >
                                {triggering === thresholdCrossed.id ? "..." : "⚡ Trigger"}
                              </Button>
                            ) : (
                              <span className="text-xs text-gray-400">
                                {pillarFormats[0]?.viewThreshold
                                  ? `${Math.round(((v.views || 0) / pillarFormats[0].viewThreshold) * 100)}%`
                                  : "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile card view */}
              <div className="sm:hidden space-y-3">
                {videos.map((v) => (
                  <div key={v.id} className="bg-white rounded-lg border border-gray-200 p-3">
                    <div className="flex gap-3">
                      {v.thumbnail && (
                        <img src={v.thumbnail} alt="" className="w-28 h-16 rounded object-cover shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <a
                          href={v.youtubeUrl || "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium text-gray-900 line-clamp-2"
                        >
                          {v.title}
                        </a>
                        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                          <span>{(v.views || 0).toLocaleString()} views</span>
                          <span>{v.publishedDate}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Pipeline Tab */}
      {activeTab === "pipeline" && (
        <div className="space-y-4">
          {pillarFormats.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
              No pillar formats yet. Create one on the Formats page to get started.
            </div>
          ) : (
            pillarFormats.map((pillar) => {
              const targets = (pillar.repurposeTargetIds || [])
                .map((id) => formats.find((f) => f.id === id))
                .filter(Boolean) as FormatRow[];

              return (
                <div key={pillar.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  <div className="bg-blue-50 border-b border-blue-100 px-4 sm:px-6 py-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">🎯</span>
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-gray-900">{pillar.name}</h3>
                            <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">Hub</Badge>
                          </div>
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {pillar.channels?.map((ch) => (
                              <span key={ch} className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded px-1.5 py-0.5">{ch}</span>
                            ))}
                          </div>
                          {pillar.viewThreshold && (
                            <p className="text-xs text-gray-500 mt-1.5">
                              Triggers at <span className="font-medium text-gray-700">{pillar.viewThreshold.toLocaleString()} views</span>
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
                    <div className="divide-y divide-gray-100">
                      {targets.map((spoke) => (
                        <div key={spoke.id} className="px-4 sm:px-6 py-3 flex items-center gap-3 hover:bg-gray-50">
                          <span className="text-lg">🔄</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-gray-900">{spoke.name}</span>
                              <Badge variant="outline" className="text-[10px] border-purple-200 text-purple-600">Spoke</Badge>
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {spoke.channels?.map((ch) => (
                                <span key={ch} className="text-[11px] text-gray-500">{ch}</span>
                              ))}
                            </div>
                          </div>
                          {spoke.contentOwner && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-medium">
                                {spoke.contentOwner.split(" ").map(n => n[0]).join("").slice(0, 2)}
                              </span>
                              <span className="text-xs text-gray-500 hidden sm:inline">{spoke.contentOwner}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-6 py-4 text-sm text-gray-400 text-center">
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
