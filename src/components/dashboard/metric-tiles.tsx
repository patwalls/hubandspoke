"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { MetricData } from "@/types";
import {
  getWeekProgress,
  type WeekStartsOn,
} from "@/lib/utils/dates";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface MetricTilesProps {
  productionData: MetricData;
  viewsData: MetricData;
  formatData: MetricData;
  weekProgress: { day: number; percent: number } | null;
  weekStartDay: number;
  currentPeriodLabel: string | null;
  weeklyGoal: number | null;
  brand: string;
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function sumPeriod(metric: MetricData, periodLabel: string | null): number {
  if (!periodLabel) return 0;
  let total = 0;
  Object.values(metric).forEach((pd) => {
    total += pd[periodLabel] || 0;
  });
  return total;
}

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="h-3.5 w-3.5"
    >
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="6.5" r="1" fill="currentColor" />
      <path d="M10 9v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function MetricTiles({
  productionData,
  viewsData,
  formatData,
  weekProgress,
  weekStartDay,
  currentPeriodLabel,
  weeklyGoal,
  brand,
}: MetricTilesProps) {
  // Recompute on the client so the fractional day/hour reflects the user's
  // local wall clock (the server runs in UTC). Re-tick every 5 min so the card
  // self-updates without a reload.
  const [liveProgress, setLiveProgress] = useState(weekProgress);
  useEffect(() => {
    const tick = () =>
      setLiveProgress(getWeekProgress(weekStartDay as WeekStartsOn));
    tick();
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [weekStartDay]);
  const wp = liveProgress ?? weekProgress;

  const currentPeriodTotal = sumPeriod(productionData, currentPeriodLabel);
  const viewsThisWeek = sumPeriod(viewsData, currentPeriodLabel);

  const projection =
    wp && wp.percent > 0
      ? Math.round(currentPeriodTotal / (wp.percent / 100))
      : 0;

  const hasGoal = weeklyGoal != null && weeklyGoal > 0;
  const onTrack =
    hasGoal &&
    currentPeriodTotal >= (weeklyGoal * (wp?.percent ?? 0)) / 100;

  const tileBorder = !hasGoal
    ? "border-border bg-card"
    : onTrack
    ? "border-primary/30 bg-primary/5"
    : "border-amber-300 bg-amber-50";

  const activeFormats = Object.keys(formatData).filter((k) =>
    Object.values(formatData[k]).some((v) => v > 0)
  ).length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className={`rounded-lg border p-4 ${tileBorder}`}>
        <div className="flex items-center gap-1">
          <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Production This Week
          </p>
          <Popover>
            <PopoverTrigger
              openOnHover
              delay={150}
              aria-label="What do these numbers mean?"
              className="text-muted-foreground/60 hover:text-muted-foreground focus:outline-none focus-visible:text-muted-foreground"
            >
              <InfoIcon />
            </PopoverTrigger>
            <PopoverContent className="w-72 text-xs leading-relaxed" side="top">
              <p>
                Pieces produced so far in the current week (against the weekly goal).
              </p>
              <p>
                <span className="font-medium text-foreground">Day X.Y of 7</span>{" "}
                — how far through the week we are, updated to the hour based on
                your browser&apos;s local time.
              </p>
              <p>
                <span className="font-medium text-foreground">Proj</span> —
                projected end-of-week total at the current pace
                (production ÷ fraction of week elapsed).
              </p>
            </PopoverContent>
          </Popover>
        </div>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {currentPeriodTotal}
          </span>
          {hasGoal && (
            <span className="text-lg text-muted-foreground">/ {weeklyGoal}</span>
          )}
        </div>
        {hasGoal ? (
          <div className="mt-3">
            <div className="w-full bg-border rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${onTrack ? 'bg-primary' : 'bg-amber-500'}`}
                style={{
                  width: `${Math.min(100, (currentPeriodTotal / weeklyGoal) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {wp
                ? `Day ${wp.day.toFixed(1)} of 7 (${Math.round(wp.percent)}%)`
                : ""}
              {" · "}
              Proj: {projection}
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <Link
              href={`/${brand}/accounts`}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Set goal
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Views This Week
        </p>
        <div className="mt-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {formatCompact(viewsThisWeek)}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Across all platforms
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Active Formats
        </p>
        <div className="mt-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {activeFormats}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Distinct formats in date range
        </p>
      </div>
    </div>
  );
}
