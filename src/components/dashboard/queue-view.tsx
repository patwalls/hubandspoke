"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isNotionAuthoritative } from "@/lib/platform";
import { IdeaQueueTable } from "./idea-queue-table";
import { SelectPill } from "./filter-pills";
import { buildChannelOptions, matchesChannel } from "@/lib/channel-options";
import type { ProductionItem } from "@/types";

interface QueueViewProps {
  brand: string;
}

const SOURCE_TABS = [
  { value: "all", label: "All" },
  { value: "original", label: "Original" },
  { value: "repost", label: "Repost" },
  { value: "cross_post", label: "Cross-post" },
] as const;

export function QueueView({ brand }: QueueViewProps) {
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("all");
  const [selectedFormat, setSelectedFormat] = useState("all");
  const [selectedSource, setSelectedSource] = useState("all");
  const [populating, setPopulating] = useState(false);

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

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const populateCrossPostQueue = useCallback(async () => {
    setPopulating(true);
    const started = Date.now();
    try {
      const res = await fetch("/api/cross-post-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIdeas: 10, maxCandidates: 20 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        result: {
          ideasCreated: number;
          candidatesConsidered: number;
          proposalsLogged: number;
          candidatesDropped: {
            noBaseline: number;
            belowVelocity: number;
          };
        };
      };
      const { ideasCreated, candidatesConsidered, proposalsLogged } =
        json.result;
      const secs = Math.round((Date.now() - started) / 1000);
      if (ideasCreated > 0) {
        toast.success(
          `Added ${ideasCreated} cross-post idea${
            ideasCreated === 1 ? "" : "s"
          } (${secs}s)`,
          {
            description: `Considered ${candidatesConsidered} fast-growing post${
              candidatesConsidered === 1 ? "" : "s"
            }; LLM scored ${proposalsLogged} proposal${
              proposalsLogged === 1 ? "" : "s"
            }.`,
            duration: 6000,
          }
        );
      } else {
        toast(
          candidatesConsidered === 0
            ? "No fast-growing posts in the last 72h to consider."
            : `Scanner ran but admitted nothing. ${proposalsLogged} proposal${
                proposalsLogged === 1 ? "" : "s"
              } logged below the confidence floor.`,
          { duration: 6000 }
        );
      }
      await fetchQueue();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Populate failed", { description: message });
    } finally {
      setPopulating(false);
    }
  }, [fetchQueue]);

  // Exclude long-form YouTube pillars — those live in Notion and don't belong
  // in the triage queue.
  const hsItems = items.filter((item) => !isNotionAuthoritative(item.platform));
  const ideaItems = hsItems.filter((item) => item.status === "Idea");

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

  // Items filtered by everything *except* source — used to compute the count
  // shown on each source tab so they reflect the active channel/format/search
  // context.
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

  const sourceCounts = useMemo(() => {
    const counts = { all: 0, original: 0, repost: 0, cross_post: 0 };
    for (const item of baseFiltered) {
      counts.all += 1;
      const source = item.sourceType ?? "original";
      if (source in counts) counts[source as keyof typeof counts] += 1;
    }
    return counts;
  }, [baseFiltered]);

  const filtered = baseFiltered.filter((item) => {
    if (selectedSource === "all") return true;
    const source = item.sourceType ?? "original";
    return source === selectedSource;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Queue
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {filtered.length}
            </span>
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Triage new ideas — assign an editor or kill.
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
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => setSelectedSource(tab.value)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 h-9 -mb-px border-b-2 text-sm transition-colors cursor-pointer",
                active
                  ? "border-foreground text-foreground font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <span>{tab.label}</span>
              <span
                className={cn(
                  "tabular-nums text-xs",
                  active ? "text-muted-foreground" : "text-muted-foreground/70"
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

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
        {selectedSource === "cross_post" && (
          <div className="ml-auto">
            <Button
              type="button"
              size="sm"
              onClick={populateCrossPostQueue}
              disabled={populating}
              className="h-8"
              title="Run the scanner and admit up to 10 high-confidence cross-post ideas to the queue. Manual only — no cron."
            >
              {populating ? (
                <span className="inline-flex items-center gap-2">
                  <svg
                    className="animate-spin h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden
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
                  Populating…
                </span>
              ) : (
                "Populate queue"
              )}
            </Button>
          </div>
        )}
      </div>

      {loading ? (
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
            <span className="text-sm">Loading queue…</span>
          </div>
        </div>
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
