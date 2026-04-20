import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  addDays,
  format,
  isAfter,
  isBefore,
  isEqual,
  differenceInDays,
  startOfQuarter,
  endOfQuarter,
  subQuarters,
  subDays,
} from "date-fns";
import type { Period } from "@/types";

export function buildPeriods(
  startDate: Date,
  endDate: Date,
  viewType: "weekly" | "daily"
): Period[] {
  const periods: Period[] = [];

  if (viewType === "weekly") {
    // Round UP to the next Sunday so W1 is always a full Sun–Sat week
    // inside the lookback window. The trailing week still ends on `endDate`
    // (typically today), so the current in-progress week is shown as-is
    // with whatever partial data exists.
    let current = startOfWeek(startDate, { weekStartsOn: 0 });
    if (differenceInDays(startDate, current) > 0) {
      current = addWeeks(current, 1);
    }
    let weekNum = 1;

    while (!isAfter(current, endDate)) {
      const weekEnd = endOfWeek(current, { weekStartsOn: 0 });
      const periodEnd = isAfter(weekEnd, endDate) ? endDate : weekEnd;

      periods.push({
        label: `W${weekNum}`,
        start: format(current, "yyyy-MM-dd"),
        end: format(periodEnd, "yyyy-MM-dd"),
      });

      weekNum++;
      current = addWeeks(current, 1);
    }
  } else {
    let current = startDate;
    while (!isAfter(current, endDate)) {
      periods.push({
        label: format(current, "M/d"),
        start: format(current, "yyyy-MM-dd"),
        end: format(current, "yyyy-MM-dd"),
      });
      current = addDays(current, 1);
    }
  }

  return periods;
}

export function findPeriod(
  dateStr: string,
  periods: Period[]
): Period | undefined {
  const d = new Date(dateStr + "T00:00:00");
  return periods.find((p) => {
    const start = new Date(p.start + "T00:00:00");
    const end = new Date(p.end + "T00:00:00");
    return (
      (isAfter(d, start) || isEqual(d, start)) &&
      (isBefore(d, end) || isEqual(d, end))
    );
  });
}

export function getWeekProgress(): { day: number; percent: number } {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const day = dayOfWeek === 0 ? 7 : dayOfWeek; // Make Sunday = 7
  const percent = Math.round((day / 7) * 100);
  return { day, percent };
}

export function getQuickRange(
  range: string
): { startDate: Date; endDate: Date } | null {
  const today = new Date();
  switch (range) {
    case "7d":
      return { startDate: subDays(today, 7), endDate: today };
    case "30d":
      return { startDate: subDays(today, 30), endDate: today };
    case "this-quarter":
      return { startDate: startOfQuarter(today), endDate: today };
    case "last-quarter": {
      const lastQ = subQuarters(today, 1);
      return { startDate: startOfQuarter(lastQ), endDate: endOfQuarter(lastQ) };
    }
    case "90d":
      return { startDate: subDays(today, 90), endDate: today };
    default:
      return null;
  }
}

export function alignToWeekBoundaries(
  startDate: Date,
  endDate: Date
): { startDate: Date; endDate: Date } {
  return {
    startDate: startOfWeek(startDate, { weekStartsOn: 0 }),
    endDate: endOfWeek(endDate, { weekStartsOn: 0 }),
  };
}
