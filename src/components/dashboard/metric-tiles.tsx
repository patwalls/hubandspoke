import type { MetricData } from "@/types";

interface MetricTilesProps {
  productionData: MetricData;
  weekProgress: { day: number; percent: number } | null;
  currentPeriodLabel: string | null;
  weeklyGoal: number;
}

export function MetricTiles({
  productionData,
  weekProgress,
  currentPeriodLabel,
  weeklyGoal,
}: MetricTilesProps) {
  let currentPeriodTotal = 0;
  if (currentPeriodLabel) {
    Object.values(productionData).forEach((periodData) => {
      currentPeriodTotal += periodData[currentPeriodLabel] || 0;
    });
  }

  let totalProduction = 0;
  Object.values(productionData).forEach((periodData) => {
    Object.values(periodData).forEach((val) => {
      totalProduction += val;
    });
  });

  const projection =
    weekProgress && weekProgress.percent > 0
      ? Math.round(currentPeriodTotal / (weekProgress.percent / 100))
      : 0;

  const onTrack = currentPeriodTotal >= weeklyGoal * (weekProgress?.percent ?? 0) / 100;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className={`rounded-lg border p-4 ${onTrack ? 'border-primary/30 bg-primary/5' : 'border-amber-300 bg-amber-50'}`}>
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Production This Week
        </p>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {currentPeriodTotal}
          </span>
          <span className="text-lg text-muted-foreground">/ {weeklyGoal}</span>
        </div>
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
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Total Production
        </p>
        <div className="mt-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {totalProduction.toLocaleString()}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          All platforms in date range
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
          Platforms Active
        </p>
        <div className="mt-2">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {Object.keys(productionData).filter(k =>
              Object.values(productionData[k]).some(v => v > 0)
            ).length}
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          With at least 1 post
        </p>
      </div>
    </div>
  );
}
