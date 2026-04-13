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

interface TriggerResult {
  sourceFormat: string;
  tasksCreated: { formatName: string; asanaGid: string; assignee?: string }[];
}

export function MATGDashboard() {
  const [formats, setFormats] = useState<FormatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<TriggerResult | null>(null);

  const fetchFormats = useCallback(async () => {
    try {
      const res = await fetch("/api/formats?brand=matg");
      const data = await res.json();
      setFormats(data);
    } catch (err) {
      console.error("Failed to fetch formats:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFormats();
  }, [fetchFormats]);

  const pillarFormats = formats.filter((f) => (f.contentType || "pillar") === "pillar");
  const spokeFormats = formats.filter((f) => f.contentType === "repurposed");

  async function handleTrigger(formatId: string) {
    setTriggering(formatId);
    setLastResult(null);
    try {
      const res = await fetch("/api/trigger-repurpose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          formatId,
          videoTitle: "Demo: Business Interview Episode",
          views: 52347,
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
          🎙️ MATG Dashboard
        </h1>
        <p className="text-xs sm:text-sm text-gray-500 mt-1">
          Content repurpose pipeline &mdash; Hub &amp; Spoke engine
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">{pillarFormats.length}</div>
          <div className="text-xs text-gray-500 mt-1">🎯 Pillar Formats</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-purple-600">{spokeFormats.length}</div>
          <div className="text-xs text-gray-500 mt-1">🔄 Spoke Formats</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{formats.length}</div>
          <div className="text-xs text-gray-500 mt-1">Total Formats</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">
            {pillarFormats.reduce((sum, f) => sum + (f.repurposeTargetIds?.length || 0), 0)}
          </div>
          <div className="text-xs text-gray-500 mt-1">Active Connections</div>
        </div>
      </div>

      {/* Success banner */}
      {lastResult && lastResult.tasksCreated.length > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-green-800 font-medium text-sm">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>
            Triggered {lastResult.tasksCreated.length} Asana tasks from &ldquo;{lastResult.sourceFormat}&rdquo;
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

      {/* Pipeline visualization */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
          Repurpose Pipeline
        </h2>

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
                {/* Pillar header */}
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
                      {triggering === pillar.id ? (
                        <span className="flex items-center gap-2">
                          <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                          Creating tasks...
                        </span>
                      ) : (
                        `Trigger Repurpose (${targets.length})`
                      )}
                    </Button>
                  </div>
                </div>

                {/* Spoke targets */}
                {targets.length > 0 ? (
                  <div className="divide-y divide-gray-100">
                    {targets.map((spoke) => (
                      <div key={spoke.id} className="px-4 sm:px-6 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                        <div className="text-gray-300 hidden sm:block">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 5v14M5 12h14" strokeLinecap="round"/></svg>
                        </div>
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
                    No repurpose targets. Add spoke formats on the Formats page.
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Standalone spoke formats (not connected to any pillar) */}
      {(() => {
        const connectedSpokeIds = new Set(
          pillarFormats.flatMap((p) => p.repurposeTargetIds || [])
        );
        const unconnectedSpokes = spokeFormats.filter(
          (f) => !connectedSpokeIds.has(f.id)
        );

        if (unconnectedSpokes.length === 0) return null;

        return (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Unconnected Spoke Formats
            </h2>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-xs text-amber-700 mb-2">
                These spoke formats aren&apos;t connected to any pillar. Add them as repurpose targets on a pillar format.
              </p>
              <div className="flex flex-wrap gap-2">
                {unconnectedSpokes.map((f) => (
                  <Badge key={f.id} variant="outline" className="text-xs border-amber-300 text-amber-700">
                    {f.name}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* How it works */}
      <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 sm:p-6">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">How the Repurpose Engine Works</h3>
        <div className="grid sm:grid-cols-3 gap-4 text-xs text-gray-600">
          <div className="flex gap-2">
            <span className="text-lg">1️⃣</span>
            <div>
              <p className="font-medium text-gray-900">Pillar content published</p>
              <p>A Business Interview goes live on YouTube</p>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="text-lg">2️⃣</span>
            <div>
              <p className="font-medium text-gray-900">Threshold reached</p>
              <p>Video hits the view threshold (e.g. 50k views)</p>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="text-lg">3️⃣</span>
            <div>
              <p className="font-medium text-gray-900">Tasks created</p>
              <p>Asana tasks auto-created for each spoke format, assigned to content owners</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
