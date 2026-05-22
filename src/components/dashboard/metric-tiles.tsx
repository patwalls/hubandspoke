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
  weeklyViewsGoal: number | null;
  brand: string;
  /** Week-over-week pacing comparison, prorated to the elapsed hours of
   *  the current week. Brand-scoped (independent of the page's filters).
   *  See `getWeekOverWeekComparison` in `src/lib/db/queries.ts`. */
  weekOverWeek?: {
    production: { current: number; prior: number | null };
    views: { current: number; prior: number | null };
  };
  /** Counts of formats by proven-status — see `format-proven.ts`. Brand-
   *  wide and date-range-independent so the headline tile is stable as
   *  the user scrubs filters. */
  provenSummary?: { proven: number; testing: number; stale: number };
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

/**
 * Small inline pill showing the week-over-week delta. Green when up,
 * red when down, muted when flat. Renders nothing when prior is null
 * (degenerate case — brand-new install, no prior-week signal).
 *
 * The percentage is the meaningful number; the raw delta is in the
 * tooltip. When prior is 0 and current > 0, percent is undefined math,
 * so we just show "↑ NEW".
 */
function DeltaBadge({
  current,
  prior,
  label,
}: {
  current: number;
  prior: number | null;
  label: string;
}) {
  if (prior == null) return null;
  const diff = current - prior;
  let display: string;
  let color: "up" | "down" | "flat";
  if (prior === 0) {
    if (current === 0) return null;
    display = "↑ NEW";
    color = "up";
  } else {
    const pct = (diff / prior) * 100;
    if (diff === 0) {
      display = "→ 0%";
      color = "flat";
    } else if (diff > 0) {
      display = `↑ +${Math.abs(pct).toFixed(0)}%`;
      color = "up";
    } else {
      display = `↓ -${Math.abs(pct).toFixed(0)}%`;
      color = "down";
    }
  }
  const palette =
    color === "up"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : color === "down"
        ? "bg-red-50 text-red-700 border-red-200"
        : "bg-muted text-muted-foreground border-border";
  const titleParts: string[] = [];
  const diffSign = diff > 0 ? "+" : "";
  titleParts.push(`${label}: ${current.toLocaleString()} this wk so far`);
  titleParts.push(`${prior.toLocaleString()} prior wk at same point`);
  titleParts.push(`Δ ${diffSign}${diff.toLocaleString()}`);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${palette}`}
      title={titleParts.join(" · ")}
    >
      {display}
    </span>
  );
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
  weeklyViewsGoal,
  brand,
  weekOverWeek,
  provenSummary,
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

  const viewsProjection =
    wp && wp.percent > 0
      ? Math.round(viewsThisWeek / (wp.percent / 100))
      : 0;
  const hasViewsGoal = weeklyViewsGoal != null && weeklyViewsGoal > 0;
  const viewsOnTrack =
    hasViewsGoal &&
    viewsThisWeek >= (weeklyViewsGoal * (wp?.percent ?? 0)) / 100;
  const viewsTileBorder = !hasViewsGoal
    ? "border-border bg-card"
    : viewsOnTrack
    ? "border-primary/30 bg-primary/5"
    : "border-amber-300 bg-amber-50";

  // Fallback to the legacy "active in date range" count when the API
  // hasn't returned a proven summary yet (loading state on first paint,
  // or the brand-all view where per-brand proven isn't computed).
  const provenFormats = provenSummary?.proven ?? null;
  const testingFormats = provenSummary?.testing ?? 0;
  const activeFormatsFallback = Object.keys(formatData).filter((k) =>
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
        <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {currentPeriodTotal}
          </span>
          {hasGoal && (
            <span className="text-lg text-muted-foreground">/ {weeklyGoal}</span>
          )}
          {weekOverWeek?.production && (
            <DeltaBadge
              current={weekOverWeek.production.current}
              prior={weekOverWeek.production.prior}
              label="Production"
            />
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

      <div className={`rounded-lg border p-4 ${viewsTileBorder}`}>
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Views This Week
        </p>
        <div className="mt-2 flex items-baseline gap-1.5 flex-wrap">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {formatCompact(viewsThisWeek)}
          </span>
          {hasViewsGoal && (
            <span className="text-lg text-muted-foreground">
              / {formatCompact(weeklyViewsGoal)}
            </span>
          )}
          {weekOverWeek?.views && (
            <DeltaBadge
              current={weekOverWeek.views.current}
              prior={weekOverWeek.views.prior}
              label="Views"
            />
          )}
        </div>
        {hasViewsGoal ? (
          <div className="mt-3">
            <div className="w-full bg-border rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${viewsOnTrack ? 'bg-primary' : 'bg-amber-500'}`}
                style={{
                  width: `${Math.min(100, (viewsThisWeek / weeklyViewsGoal) * 100)}%`,
                }}
              />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
              {wp
                ? `Day ${wp.day.toFixed(1)} of 7 (${Math.round(wp.percent)}%)`
                : ""}
              {" · "}
              Proj: {formatCompact(viewsProjection)}
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

      <Link
        href={`/${brand}/formats`}
        className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40"
      >
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          {provenFormats !== null ? "Proven Formats" : "Active Formats"}
        </p>
        <div className="mt-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {provenFormats !== null ? provenFormats : activeFormatsFallback}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {provenFormats !== null
            ? testingFormats > 0
              ? `+${testingFormats} in testing · last 180 days`
              : `Last 180 days`
            : "Distinct formats in date range"}
        </p>
      </Link>
    </div>
  );
}
