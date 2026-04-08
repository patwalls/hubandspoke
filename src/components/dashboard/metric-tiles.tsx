import { Card, CardContent } from "@/components/ui/card";
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
  // Calculate total production for the current period
  let currentPeriodTotal = 0;
  if (currentPeriodLabel) {
    Object.values(productionData).forEach((periodData) => {
      currentPeriodTotal += periodData[currentPeriodLabel] || 0;
    });
  }

  // Calculate total production across all periods
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

  const needsPush = currentPeriodTotal < weeklyGoal * (weekProgress?.percent ?? 0) / 100;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <Card className={needsPush ? "border-amber-300 bg-amber-50" : ""}>
        <CardContent className="pt-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            {needsPush && (
              <span className="text-amber-600 font-semibold">Needs Push - </span>
            )}
            Production This Week
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-3xl font-bold text-gray-900">
              {currentPeriodTotal}
            </span>
            <span className="text-lg text-gray-400">/ {weeklyGoal}</span>
          </div>
          <div className="mt-2">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (currentPeriodTotal / weeklyGoal) * 100)}%`,
                }}
              />
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {weekProgress
                ? `Day ${weekProgress.day} of 7 (${weekProgress.percent}% of week)`
                : ""}
              {" | "}
              Projection: {projection} ({Math.round((projection / weeklyGoal) * 100)}%)
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Total Production
          </div>
          <div className="mt-1">
            <span className="text-3xl font-bold text-gray-900">
              {totalProduction.toLocaleString()}
            </span>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Across all platforms in date range
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
