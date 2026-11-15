"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { CrossPostTriagePanel } from "./cross-post-triage-dialog";
import type { TargetCommonalityRow } from "@/lib/cross-post-usual";

type PanelProps = ComponentProps<typeof CrossPostTriagePanel>;

/**
 * The content page's Cross-post tab: the queue dialog's panel plus where this
 * item's format usually goes, so its targets are ranked the same way and
 * "Select usual (N)" shows here too (people cross-post from this tab far more
 * than from the queue). The tab only mounts when opened, so the lookup runs
 * then, not on every post page load. Waits for the ranking before drawing the
 * list so rows don't reorder under a click; a failed lookup just draws the
 * unranked list.
 */
export function CrossPostTabPanel(props: Omit<PanelProps, "targetCommonality">) {
  const itemId = props.candidate.id;
  const [ranking, setRanking] = useState<
    Record<string, TargetCommonalityRow[]> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/production-items/${itemId}/cross-post-usual`)
      .then((r) => (r.ok ? r.json() : { targetCommonality: {} }))
      .catch(() => ({ targetCommonality: {} }))
      .then((body: { targetCommonality?: Record<string, TargetCommonalityRow[]> }) => {
        if (!cancelled) setRanking(body.targetCommonality ?? {});
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (ranking === null) {
    return <div className="h-40 animate-pulse rounded-md bg-muted/40" aria-hidden />;
  }
  return <CrossPostTriagePanel {...props} targetCommonality={ranking} />;
}
