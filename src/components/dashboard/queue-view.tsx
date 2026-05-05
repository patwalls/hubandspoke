"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCwIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isNotionAuthoritative } from "@/lib/platform";
import { IdeaQueueTable } from "./idea-queue-table";
import { CrossPostQueueTable } from "./cross-post-queue-table";
import { HistoryQueueTable } from "./history-queue-table";
import { SelectPill } from "./filter-pills";
import { buildChannelOptions, matchesChannel } from "@/lib/channel-options";
import type { ProductionItem } from "@/types";
import type { CrossPostCandidatesResult } from "@/lib/services/cross-post-candidates";
import type { QueueHistoryEvent } from "@/app/api/queue/history/route";

export type QueueSource =
  | "all"
  | "original"
  | "repost"
  | "cross_post"
  | "clip"
  | "history";

interface QueueViewProps {
  brand: string;
  initialSource: QueueSource;
  isAdmin?: boolean;
}

const SOURCE_TABS = [
  { value: "all", label: "All", slug: "" },
  { value: "original", label: "Original", slug: "original" },
  { value: "repost", label: "Repost", slug: "repost" },
  { value: "cross_post", label: "Cross-post", slug: "cross-post" },
  { value: "clip", label: "Clip", slug: "clip" },
  { value: "history", label: "History", slug: "history" },
] as const;

export function QueueView({
  brand,
  initialSource,
  isAdmin = false,
}: QueueViewProps) {
  const router = useRouter();
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [crossPostData, setCrossPostData] =
    useState<CrossPostCandidatesResult | null>(null);
  const [crossPostLoading, setCrossPostLoading] = useState(true);
  const [historyEvents, setHistoryEvents] = useState<QueueHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [refilling, setRefilling] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [selectedFormat, setSelectedFormat] = useState("all");
  const [selectedSource, setSelectedSource] = useState<QueueSource>(
    initialSource
  );

  useEffect(() => {
    setSelectedSource(initialSource);
  }, [initialSource]);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reports/production?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Queue API returned HTTP ${res.status}`);
        setItems([]);
        return;
      }
      const json = await res.json();
      setItems(json.items ?? []);
    } catch (err) {
      console.error("Failed to fetch queue:", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  const fetchCrossPostQueue = useCallback(async () => {
    setCrossPostLoading(true);
    try {
      const res = await fetch(
        `/api/cross-post-queue?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Cross-post queue API returned HTTP ${res.status}`);
        setCrossPostData({
          items: [],
          brandAccounts: [],
          targetCommonality: {},
          stats: {
            rawCandidates: 0,
            droppedDismissed: 0,
            droppedBelowThreshold: 0,
            droppedAllTargetsCovered: 0,
            droppedNoCompatibleTarget: 0,
            autoAdmittedNewFormat: 0,
          },
          config: {
            candidateWindowDays: 21,
            cohortWindowDays: 90,
            percentile: 0.6,
            hotnessThreshold: 1.0,
          },
        });
        return;
      }
      const json = (await res.json()) as CrossPostCandidatesResult;
      setCrossPostData(json);
    } catch (err) {
      console.error("Failed to fetch cross-post queue:", err);
      setCrossPostData(null);
    } finally {
      setCrossPostLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    fetchCrossPostQueue();
  }, [fetchCrossPostQueue]);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/queue/history?brand=${encodeURIComponent(brand)}`,
      );
      if (!res.ok) {
        console.error(`History API returned HTTP ${res.status}`);
        setHistoryEvents([]);
        return;
      }
      const json = await res.json();
      setHistoryEvents(json.events ?? []);
    } catch (err) {
      console.error("Failed to fetch queue history:", err);
      setHistoryEvents([]);
    } finally {
      setHistoryLoading(false);
      setHistoryLoaded(true);
    }
  }, [brand]);

  // Lazy-load history only when the user actually opens the tab.
  useEffect(() => {
    if (selectedSource === "history" && !historyLoaded) {
      void fetchHistory();
    }
  }, [selectedSource, historyLoaded, fetchHistory]);

  const handleRefillReposts = useCallback(async () => {
    if (refilling) return;
    setRefilling(true);
    try {
      const res = await fetch("/api/queue/refill-reposts", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error || `Refill failed (HTTP ${res.status})`);
        return;
      }
      toast.success(
        "Repost scan enqueued — new ideas will appear in a moment.",
      );
      // Give the worker a few seconds to chew through Phase A/B then
      // refetch. Phase B writes one repost row per accepted candidate so we
      // can see the queue grow.
      window.setTimeout(() => {
        void fetchQueue();
      }, 6000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refill failed");
    } finally {
      setRefilling(false);
    }
  }, [refilling, fetchQueue]);

  // Exclude long-form YouTube pillars — those live in Notion and don't belong
  // in the triage queue.
  const hsItems = items.filter((item) => !isNotionAuthoritative(item.postType));
  // The All / Original / Repost / Clip tabs only show triage-Idea rows.
  // Cross-post is a separate queue (live view of hot Published originals)
  // and is filtered out of the Idea pool here.
  const ideaItems = hsItems.filter(
    (item) => item.status === "Idea" && item.sourceType !== "cross_post"
  );

  const platformOptions = useMemo(
    () => buildChannelOptions(ideaItems),
    [ideaItems]
  );

  const formatOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of ideaItems) {
      if (item.format) set.add(item.format);
    }
    return [
      { value: "all", label: "All formats" },
      ...Array.from(set)
        .sort((a, b) => a.localeCompare(b))
        .map((f) => ({ value: f, label: f })),
    ];
  }, [ideaItems]);

  const query = search.trim().toLowerCase();

  const baseFiltered = ideaItems.filter((item) => {
    if (!matchesChannel(item, selectedPlatform)) return false;
    if (selectedFormat !== "all") {
      if (item.format !== selectedFormat) return false;
    }
    if (query) {
      const haystack = [
        item.title,
        item.format,
        item.platform?.join(" "),
        item.producerEmail,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Cross-post candidates filtered by the same channel/format/search controls.
  const crossPostFiltered = useMemo(() => {
    const candidates = crossPostData?.items ?? [];
    return candidates.filter((c) => {
      if (
        !matchesChannel(
          { accountId: c.account.id, postType: c.postType, account: c.account },
          selectedPlatform
        )
      )
        return false;
      if (selectedFormat !== "all" && c.format !== selectedFormat) return false;
      if (query) {
        const haystack = [c.title, c.format, c.account.handle]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [crossPostData, selectedPlatform, selectedFormat, query]);

  const sourceCounts = useMemo(() => {
    const counts = {
      all: 0,
      original: 0,
      repost: 0,
      cross_post: 0,
      clip: 0,
      history: 0,
    };
    for (const item of baseFiltered) {
      counts.all += 1;
      const source = item.sourceType ?? "original";
      if (source === "cross_post") continue;
      if (source in counts) counts[source as keyof typeof counts] += 1;
    }
    counts.cross_post = crossPostFiltered.length;
    counts.history = historyEvents.length;
    return counts;
  }, [baseFiltered, crossPostFiltered, historyEvents]);

  const filtered = baseFiltered.filter((item) => {
    if (selectedSource === "all") return true;
    const source = item.sourceType ?? "original";
    return source === selectedSource;
  });

  const isCrossPostTab = selectedSource === "cross_post";
  const isHistoryTab = selectedSource === "history";
  const isRepostTab = selectedSource === "repost";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Queue
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {isHistoryTab
                ? historyEvents.length
                : isCrossPostTab
                ? crossPostFiltered.length
                : filtered.length}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            {isHistoryTab
              ? "Items that have left the queue in the last 30 days."
              : isCrossPostTab
              ? "High-performing posts from the last 21 days — pick where to cross-post."
              : "Triage new ideas — assign an editor or kill."}
          </p>
        </div>
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, format, channel, producer…"
          className="h-8 w-48 sm:w-72 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {SOURCE_TABS.map((tab) => {
          const active = selectedSource === tab.value;
          const count = sourceCounts[tab.value as keyof typeof sourceCounts];
          const href = tab.slug
            ? `/${brand}/queue/${tab.slug}`
            : `/${brand}/queue`;
          // History is read-only and sits apart from the triage tabs — push
          // it to the right with a small left margin and a more muted
          // baseline color so it reads as a side trip, not a queue source.
          const isHistory = tab.value === "history";
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => {
                setSelectedSource(tab.value);
                router.push(href);
              }}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 h-9 -mb-px border-b-2 text-sm transition-colors cursor-pointer",
                isHistory && "ml-auto text-xs",
                active
                  ? "border-foreground text-foreground font-medium"
                  : isHistory
                  ? "border-transparent text-muted-foreground/70 hover:text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{tab.label}</span>
              {!isHistory && (
                <span
                  className={cn(
                    "tabular-nums text-xs",
                    active
                      ? "text-muted-foreground"
                      : "text-muted-foreground/70",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!isHistoryTab && (
        <div className="flex flex-wrap items-center gap-2">
          <SelectPill
            label="Channel"
            value={selectedPlatform}
            options={platformOptions}
            onChange={setSelectedPlatform}
          />
          <SelectPill
            label="Format"
            value={selectedFormat}
            options={formatOptions}
            onChange={setSelectedFormat}
          />
          {isRepostTab && isAdmin && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefillReposts}
              disabled={refilling}
              className="ml-auto"
              title="Re-run the evergreen-scan task that populates this queue (admin only)"
            >
              <RefreshCwIcon
                className={cn("size-3.5", refilling && "animate-spin")}
              />
              {refilling ? "Refilling…" : "Repopulate"}
            </Button>
          )}
        </div>
      )}

      {isHistoryTab ? (
        <HistoryQueueTable
          events={historyEvents}
          brand={brand}
          loading={historyLoading}
          emptyMessage="Nothing has moved through the queue in the last 30 days."
        />
      ) : isCrossPostTab ? (
        crossPostLoading ? (
          <LoadingPanel label="Loading hot posts…" />
        ) : (
          <CrossPostQueueTable
            items={crossPostFiltered}
            brandAccounts={crossPostData?.brandAccounts ?? []}
            targetCommonality={crossPostData?.targetCommonality}
            brand={brand}
            emptyMessage={
              query ||
              selectedPlatform !== "all" ||
              selectedFormat !== "all"
                ? "No hot posts match the current filters."
                : "Nothing hot in the last 21 days. Check back tomorrow."
            }
            onMutate={fetchCrossPostQueue}
          />
        )
      ) : loading ? (
        <LoadingPanel label="Loading queue…" />
      ) : (
        <IdeaQueueTable
          items={filtered}
          brand={brand}
          emptyMessage={
            query ||
            selectedPlatform !== "all" ||
            selectedFormat !== "all" ||
            selectedSource !== "all"
              ? "No ideas match the current filters."
              : "Nothing to triage — the queue is empty."
          }
          onMutate={fetchQueue}
        />
      )}
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="flex items-center gap-2 text-muted-foreground">
        <svg
          className="animate-spin h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}
