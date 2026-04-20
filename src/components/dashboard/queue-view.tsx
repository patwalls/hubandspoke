"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { isNotionAuthoritative } from "@/lib/platform";
import { IdeaQueueTable } from "./idea-queue-table";
import type { ProductionItem } from "@/types";

interface QueueViewProps {
  brand: string;
}

export function QueueView({ brand }: QueueViewProps) {
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

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

  // Exclude long-form YouTube pillars — those live in Notion and don't belong
  // in the triage queue.
  const hsItems = items.filter((item) => !isNotionAuthoritative(item.platform));
  const ideaItems = hsItems.filter((item) => item.status === "Idea");

  const query = search.trim().toLowerCase();
  const filtered = query
    ? ideaItems.filter((item) => {
        const haystack = [
          item.title,
          item.format,
          item.platform?.join(" "),
          item.producerEmail,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : ideaItems;

  const repostCount = filtered.filter(
    (i) => i.sourceType === "repost"
  ).length;
  const crossPostCount = filtered.filter(
    (i) => i.sourceType === "cross_post"
  ).length;

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
            {repostCount > 0 && (
              <>
                {" "}
                <span className="text-amber-700">
                  {repostCount} repost suggestion{repostCount === 1 ? "" : "s"}
                </span>{" "}
                waiting.
              </>
            )}
            {crossPostCount > 0 && (
              <>
                {" "}
                <span className="text-indigo-700">
                  {crossPostCount} cross-post suggestion
                  {crossPostCount === 1 ? "" : "s"}
                </span>{" "}
                waiting.
              </>
            )}
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
            query
              ? `No ideas match “${search}”.`
              : "Nothing to triage — the queue is empty."
          }
          onMutate={fetchQueue}
        />
      )}
    </div>
  );
}
