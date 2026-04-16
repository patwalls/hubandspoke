import Link from "next/link";
import type { MetricData } from "@/types";

interface MetricTilesProps {
  productionData: MetricData;
  viewsData: MetricData;
  formatData: MetricData;
  weekProgress: { day: number; percent: number } | null;
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

export function MetricTiles({
  productionData,
  viewsData,
  formatData,
  weekProgress,
  currentPeriodLabel,
  weeklyGoal,
  brand,
}: MetricTilesProps) {
  const currentPeriodTotal = sumPeriod(productionData, currentPeriodLabel);
  const viewsThisWeek = sumPeriod(viewsData, currentPeriodLabel);

  const projection =
    weekProgress && weekProgress.percent > 0
      ? Math.round(currentPeriodTotal / (weekProgress.percent / 100))
      : 0;

  const hasGoal = weeklyGoal != null && weeklyGoal > 0;
  const onTrack =
    hasGoal &&
    currentPeriodTotal >= (weeklyGoal * (weekProgress?.percent ?? 0)) / 100;

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
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Production This Week
        </p>
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
            <p className="mt-1.5 text-xs text-muted-foreground">
              {weekProgress
                ? `Day ${weekProgress.day} of 7 (${weekProgress.percent}%)`
                : ""}
              {" · "}
              Proj: {projection}
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <Link
              href={`/${brand}/settings`}
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
