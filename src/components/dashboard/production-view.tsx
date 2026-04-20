"use client";

import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isNotionAuthoritative } from "@/lib/platform";
import { ProductionPipelineTable } from "./production-pipeline-table";
import type { ProductionItem } from "@/types";

interface ProductionViewProps {
  brand: string;
}

// Long-form YouTube pillars (YouTube, YouTube (SS), YouTube (SS Build)) are
// excluded — those live in Notion. Idea-stage triage moved to /[brand]/queue.
const PIPELINE_STATUSES = [
  "Ready To Publish",
  "Final Review",
  "Review",
  "Assigned",
] as const;

const STATUS_COLORS: Record<string, string> = {
  "Ready To Publish": "bg-pink-100 text-pink-800 border-pink-200",
  "Final Review": "bg-orange-100 text-orange-800 border-orange-200",
  Review: "bg-yellow-100 text-yellow-800 border-yellow-200",
  Assigned: "bg-blue-100 text-blue-800 border-blue-200",
};

export function ProductionView({ brand }: ProductionViewProps) {
  const [items, setItems] = useState<ProductionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/reports/production?brand=${encodeURIComponent(brand)}`
      );
      if (!res.ok) {
        console.error(`Production API returned HTTP ${res.status}`);
        setItems([]);
        return;
      }
      const json = await res.json();
      setItems(json.items ?? []);
    } catch (err) {
      console.error("Failed to fetch production pipeline:", err);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [brand]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  const hsItems = items.filter((item) => !isNotionAuthoritative(item.platform));

  const query = search.trim().toLowerCase();
  const matchesQuery = (item: ProductionItem): boolean => {
    if (!query) return true;
    const title = item.title?.toLowerCase() ?? "";
    const format = item.format?.toLowerCase() ?? "";
    const platforms = item.platform?.join(" ").toLowerCase() ?? "";
    const producer = item.producerEmail?.toLowerCase() ?? "";
    return (
      title.includes(query) ||
      format.includes(query) ||
      platforms.includes(query) ||
      producer.includes(query)
    );
  };

  const pipelineItems = hsItems
    .filter(matchesQuery)
    .filter(
      (item) =>
        item.status &&
        (PIPELINE_STATUSES as readonly string[]).includes(item.status)
    );

  const byStatus = new Map<string, ProductionItem[]>();
  for (const status of PIPELINE_STATUSES) byStatus.set(status, []);
  for (const item of pipelineItems) {
    const bucket = item.status ? byStatus.get(item.status) : null;
    if (bucket) bucket.push(item);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-foreground">
            Production
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Track content moving through the pipeline.
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
            <span className="text-sm">Loading production pipeline…</span>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {PIPELINE_STATUSES.map((status) => {
            const statusItems = byStatus.get(status) ?? [];
            if (statusItems.length === 0) return null;
            return (
              <section key={status} className="space-y-3">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border",
                      STATUS_COLORS[status]
                    )}
                  >
                    {status}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {statusItems.length}
                  </span>
                </div>
                <ProductionPipelineTable items={statusItems} brand={brand} />
              </section>
            );
          })}

          {pipelineItems.length === 0 && (
            <div className="text-center py-20">
              <p className="text-muted-foreground text-sm">
                {query
                  ? `No items match “${search}”.`
                  : "No items in the pipeline."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
