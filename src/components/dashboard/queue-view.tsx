"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isNotionAuthoritative } from "@/lib/platform";
import { SelectPill } from "./filter-pills";
const HistoryQueueTable = dynamic(() => import("./history-queue-table").then((m) => m.HistoryQueueTable), { ssr: false });
const SpokeQueueTable = dynamic(() => import("./spoke-queue-table").then((m) => m.SpokeQueueTable), { ssr: false });
const RepostQueueTable = dynamic(() => import("./repost-queue-table").then((m) => m.RepostQueueTable), { ssr: false });
const CrossPostQueueTable = dynamic(() => import("./cross-post-queue-table").then((m) => m.CrossPostQueueTable), { ssr: false });
// Static import ON PURPOSE: this is the default tab — dynamic() suspends
// during SSR (fallback lands in the HTML instead of rows) and the page
// cannot paint content before hydration. The other four tables stay lazy;
// they only render behind tab clicks.
import { IdeaQueueTable } from "./idea-queue-table";
import { buildChannelOptions, matchesChannel } from "@/lib/channel-options";
import type { ProductionItem } from "@/types";
import type { CrossPostCandidatesResult } from "@/lib/services/cross-post-candidates";
import type { RepostCandidatesResult } from "@/lib/services/repost-candidates";
import type { SpokeCandidatesResult } from "@/lib/services/spoke-candidates";
import type { QueueHistoryEvent } from "@/app/api/queue/history/route";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useRememberListUrl } from "@/lib/hooks/use-remember-list-url";

/** Queue tab discriminator.
 *
 *   - Static slots: "all" | "repurposed" | "spoke" | "cross_post" | "repost"
 *     | "history" — fixed Queue tabs that map 1:1 to a known sub-route.
 *   - Dynamic per-clippable-format slot: a string of the form
 *     `clip:<formatId>` — one for each `formats.is_clippable_format=true`
 *     row on the brand. Rendered as a tab labeled with the format's name
 *     (e.g. "Repackage Section w/ Hook", "X Quotables"). Replaces the
 *     legacy single "clip_ideas" tab.
 */
export type QueueSource =
  | "all"
  | "repurposed"
  | "spoke"
  | "cross_post"
  | "repost"
  | "history"
  | `clip:${string}`;

export interface ClippableFormatTab {
  id: string;
  name: string;
  slug: string;
}

interface QueueViewProps {
  brand: string;
  /** SSR'd production-report items (JSON-roundtripped). When present the
   *  All tab paints immediately and the mount fetch is skipped; manual
   *  refreshes/mutations still refetch via fetchQueue(). */
  initialItems?: ProductionItem[];
  initialSource: QueueSource;
  /** When initialSource is a `clip:<formatId>` value, this is the human-
   *  readable format name to filter rows by (matches `production_items.format`).
   *  Resolved server-side from the URL slug. */
  initialClipFormatFilter?: string | null;
  clippableFormats: ClippableFormatTab[];
  /** Format-name → format-id lookup for every format on the brand
   *  (clippable + non-clippable). Used by the Queue table to render the
   *  Format cell as a link to the format detail page. */
  formatNameToId?: Record<string, string>;
  /** Retained for back-compat with the page route; v2 doesn't expose any
   *  admin-only controls, so this is currently a no-op. */
  isAdmin?: boolean;
}

const STATIC_SOURCE_TABS = [
  { value: "all" as const, label: "All", slug: "" },
  { value: "spoke" as const, label: "Repurposed", slug: "repurposed" },
  { value: "repurposed" as const, label: "Triggered", slug: "triggered" },
  // Per-clippable-format tabs get spliced in here at render time.
  { value: "cross_post" as const, label: "Cross-post", slug: "cross-post" },
  { value: "repost" as const, label: "Repost", slug: "repost" },
  { value: "history" as const, label: "History", slug: "history" },
];

export function QueueView({
  brand,
  initialItems,
  initialSource,
  initialClipFormatFilter = null,
  clippableFormats = [],
  formatNameToId = {},
  isAdmin: _isAdmin = false,
}: QueueViewProps) {
  // Per-format tabs spliced into the static set at the legacy "clip_ideas"
  // position. One entry per `is_clippable_format=true` format on the brand,
  // labeled by format name and routed under `/queue/<format-slug>`.
  const sourceTabs = useMemo(() => {
    const formatTabs = clippableFormats.map((f) => ({
      value: `clip:${f.id}` as QueueSource,
      label: f.name,
      slug: f.slug,
    }));
    // Splice after "Triggered" (index 2) and before "Cross-post".
    return [
      ...STATIC_SOURCE_TABS.slice(0, 3),
      ...formatTabs,
      ...STATIC_SOURCE_TABS.slice(3),
    ];
  }, [clippableFormats]);

  // Lookup table: source value → the production_items.format string that
  // rows must match to belong in that tab. Only populated for clip-format
  // tabs; null for static tabs.
  const clipFormatNameBySource = useMemo(() => {
    const map = new Map<QueueSource, string>();
    for (const f of clippableFormats) {
      map.set(`clip:${f.id}` as QueueSource, f.name);
    }
    return map;
  }, [clippableFormats]);

  const currentClipFormatName = (selectedSource: QueueSource): string | null =>
    clipFormatNameBySource.get(selectedSource) ?? null;
  void initialClipFormatFilter;
  const router = useRouter();
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(!initialItems); // SSR path: rows are already in state — render them in the server HTML, not a spinner
  const [crossPostData, setCrossPostData] =
    useState<CrossPostCandidatesResult | null>(null);
  const [crossPostLoading, setCrossPostLoading] = useState(true);
  const [repostData, setRepostData] = useState<RepostCandidatesResult | null>(
    null
  );
  const [repostLoading, setRepostLoading] = useState(true);
  const [spokeData, setSpokeData] = useState<SpokeCandidatesResult | null>(null);
  const [spokeLoading, setSpokeLoading] = useState(true);
  const [historyEvents, setHistoryEvents] = useState<QueueHistoryEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Filter state lives in the URL so back-nav + shareable links work.
  // The active queue tab (`selectedSource`) is already URL-driven via the
  // route segment `[source]` — only the within-tab filters need lifting.
  const filters = useUrlState({
    q: { default: "", debounceMs: 250 },
    platform: { default: "all" },
    format: { default: "all" },
  });
  const {
    q: search,
    platform: selectedPlatform,
    format: selectedFormat,
  } = filters.values;
  const [selectedSource, setSelectedSource] = useState<QueueSource>(
    initialSource
  );

  useEffect(() => {
    setSelectedSource(initialSource);
  }, [initialSource]);

  useRememberListUrl({ brand, listKey: "queue" });

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

  const fetchRepostQueue = useCallback(async () => {
    setRepostLoading(true);
    try {
      const res = await fetch(
        `/api/repost-queue?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Repost queue API returned HTTP ${res.status}`);
        setRepostData({
          items: [],
          stats: {
            rawCandidates: 0,
            droppedNonRepostablePlatform: 0,
            droppedOriginalOnPlatform: 0,
            droppedDismissed: 0,
            droppedPriorKilled: 0,
            droppedCooldown: 0,
            droppedPendingInFlight: 0,
            droppedNoCohort: 0,
            droppedBelowThreshold: 0,
          },
          config: {
            cohortPercentile: 0.75,
            hotnessThreshold: 1.5,
            minCohort: 5,
            minAgeDaysByPlatform: {},
            minAgeDaysDefault: 180,
            noOriginalRepostPlatforms: [],
            noRepostPlatforms: [],
          },
        });
        return;
      }
      const json = (await res.json()) as RepostCandidatesResult;
      setRepostData(json);
    } catch (err) {
      console.error("Failed to fetch repost queue:", err);
      setRepostData(null);
    } finally {
      setRepostLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchRepostQueue();
  }, [fetchRepostQueue]);

  const fetchSpokeQueue = useCallback(async () => {
    setSpokeLoading(true);
    try {
      const res = await fetch(
        `/api/spoke-queue?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Spoke queue API returned HTTP ${res.status}`);
        setSpokeData({
          items: [],
          stats: {
            rawPillars: 0,
            rawFormats: 0,
            rawPairs: 0,
            droppedNoChannelCohort: 0,
            droppedNoChildFormats: 0,
            droppedInFlight: 0,
            droppedCooldown: 0,
            droppedBelowThreshold: 0,
            droppedDismissed: 0,
          },
          config: {
            pillarWindowDays: 730,
            channelCohortWindowDays: 365,
            formatCohortWindowDays: 90,
            pairSourceCohortWindowDays: 180,
            pairPubCooldownDays: 14,
            percentile: 0.6,
            minFormatHistory: 3,
            spokeThreshold: 1.0,
            // Match the v1.1 constants in spoke-candidates.ts. Only
            // relevant if the error-state config block is ever read, but
            // keeps the fallback honest.
            freshnessHalfLifeDays: 45,
            freshnessFloor: 0.15,
          },
        });
        return;
      }
      const json = (await res.json()) as SpokeCandidatesResult;
      setSpokeData(json);
    } catch (err) {
      console.error("Failed to fetch spoke queue:", err);
      setSpokeData(null);
    } finally {
      setSpokeLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchSpokeQueue();
  }, [fetchSpokeQueue]);

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

  // Exclude long-form YouTube pillars — those live in Notion and don't belong
  // in the triage queue.
  const hsItems = items.filter((item) => !isNotionAuthoritative(item.postType));
  // The All / Original / Clip tabs show triage-Idea rows.
  // Cross-post is a separate live query of hot Published originals.
  // Repost is also a separate live query (v2) of elite evergreen
  // candidates — never has Idea rows itself, so it's filtered out of
  // the Idea pool here too.
  const ideaItems = hsItems.filter(
    (item) =>
      item.status === "Idea" &&
      item.sourceType !== "cross_post" &&
      item.sourceType !== "repost"
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

  // Repost v2 candidates — same filter ergonomics as the cross-post tab.
  const repostFiltered = useMemo(() => {
    const candidates = repostData?.items ?? [];
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
  }, [repostData, selectedPlatform, selectedFormat, query]);

  // SPOKE (pillar × format) candidates — filtered by channel (the pillar's
  // YouTube account), format, and free-text search across pillar title +
  // format + channel handle.
  const spokeFiltered = useMemo(() => {
    const candidates = spokeData?.items ?? [];
    return candidates.filter((c) => {
      if (
        !matchesChannel(
          {
            accountId: c.pillar.account.id,
            postType: "youtube_long",
            account: c.pillar.account,
          },
          selectedPlatform
        )
      )
        return false;
      if (selectedFormat !== "all" && c.format.name !== selectedFormat) {
        return false;
      }
      if (query) {
        const haystack = [
          c.pillar.title,
          c.format.name,
          c.pillar.account.handle,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [spokeData, selectedPlatform, selectedFormat, query]);

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: 0,
      repurposed: 0,
      spoke: 0,
      cross_post: 0,
      repost: 0,
      history: 0,
    };
    // One counter slot per dynamic clip-format tab.
    for (const f of clippableFormats) {
      counts[`clip:${f.id}`] = 0;
    }
    // Build a quick format-name → source-key map so we can bucket rows
    // into their per-format tab in one pass.
    const formatNameToSource = new Map<string, string>();
    for (const f of clippableFormats) {
      formatNameToSource.set(f.name, `clip:${f.id}`);
    }
    for (const item of baseFiltered) {
      counts.all += 1;
      const source = item.sourceType ?? "original";
      if (source === "cross_post" || source === "repost") continue;
      // Repurposed rows fork on whether a clip-idea is attached:
      //   - With sourceClipIdeaId → belongs in the row's format-specific
      //     clip tab (matched by format name). Falls into nothing visible
      //     if the row's format isn't currently clippable (rare — drift
      //     between clip generation time and the current flag).
      //   - Without → "Triggered" tab.
      if (source === "repurposed") {
        if (item.sourceClipIdeaId) {
          const key = item.format
            ? formatNameToSource.get(item.format)
            : undefined;
          if (key) counts[key] = (counts[key] ?? 0) + 1;
        } else {
          counts.repurposed += 1;
        }
      }
    }
    counts.cross_post = crossPostFiltered.length;
    counts.repost = repostFiltered.length;
    counts.spoke = spokeFiltered.length;
    counts.history = historyEvents.length;
    return counts;
  }, [
    baseFiltered,
    crossPostFiltered,
    repostFiltered,
    spokeFiltered,
    historyEvents,
    clippableFormats,
  ]);

  const filtered = baseFiltered.filter((item) => {
    if (selectedSource === "all") return true;
    const source = item.sourceType ?? "original";
    // Triggered tab: repurposed rows without a clip-idea attached.
    if (selectedSource === "repurposed") {
      return source === "repurposed" && !item.sourceClipIdeaId;
    }
    // Per-format clip tabs: filter by clip-idea presence AND format name.
    const formatNameForTab = currentClipFormatName(selectedSource);
    if (formatNameForTab) {
      return (
        source === "repurposed" &&
        !!item.sourceClipIdeaId &&
        item.format === formatNameForTab
      );
    }
    return source === selectedSource;
  });

  const isCrossPostTab = selectedSource === "cross_post";
  const isHistoryTab = selectedSource === "history";
  const isRepostTab = selectedSource === "repost";
  const isSpokeTab = selectedSource === "spoke";

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
                  : isRepostTab
                    ? repostFiltered.length
                    : isSpokeTab
                      ? spokeFiltered.length
                      : filtered.length}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            {isHistoryTab
              ? "Items that have left the queue in the last 30 days."
              : isCrossPostTab
                ? "High-performing posts from the last 21 days — pick where to cross-post."
                : isRepostTab
                  ? "Elite evergreen — past hits that beat their format on this channel by ≥1.5× the top quartile."
                  : isSpokeTab
                    ? "SPOKE algorithm — top (pillar × format) pairs scored by performance, freshness, and pair history."
                    : "Triage new ideas — assign an editor or kill."}
          </p>
        </div>
        <Input
          type="search"
          value={search}
          onChange={(e) => filters.set("q", e.target.value)}
          placeholder="Search title, format, channel…"
          className="h-8 w-48 sm:w-72 text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-border">
        {sourceTabs.map((tab) => {
          const active = selectedSource === tab.value;
          const count = sourceCounts[tab.value] ?? 0;
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
            onChange={(v) => filters.set("platform", v)}
          />
          <SelectPill
            label="Format"
            value={selectedFormat}
            options={formatOptions}
            onChange={(v) => filters.set("format", v)}
          />
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
      ) : isRepostTab ? (
        repostLoading ? (
          <LoadingPanel label="Loading evergreen candidates…" />
        ) : (
          <RepostQueueTable
            items={repostFiltered}
            brand={brand}
            emptyMessage={
              query ||
              selectedPlatform !== "all" ||
              selectedFormat !== "all"
                ? "No evergreen candidates match the current filters."
                : "No elite evergreen right now. The bar is high — give it time as more cohort data lands."
            }
            onMutate={fetchRepostQueue}
          />
        )
      ) : isSpokeTab ? (
        spokeLoading ? (
          <LoadingPanel label="Running SPOKE algorithm…" />
        ) : (
          <SpokeQueueTable
            items={spokeFiltered}
            brand={brand}
            emptyMessage={
              query ||
              selectedPlatform !== "all" ||
              selectedFormat !== "all"
                ? "No SPOKE candidates match the current filters."
                : "No SPOKE candidates above the bar right now. Pillars need to clear their channel's typical performance to surface."
            }
            onMutate={fetchSpokeQueue}
          />
        )
      ) : loading ? (
        <LoadingPanel label="Loading queue…" />
      ) : (
        <IdeaQueueTable
          items={filtered}
          brand={brand}
          formatNameToId={formatNameToId}
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
