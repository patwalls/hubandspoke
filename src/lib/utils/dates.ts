import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  addDays,
  startOfMonth,
  endOfMonth,
  addMonths,
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

export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function buildPeriods(
  startDate: Date,
  endDate: Date,
  viewType: "weekly" | "daily" | "monthly",
  weekStartsOn: WeekStartsOn = 0
): Period[] {
  const periods: Period[] = [];

  if (viewType === "weekly") {
    // Round UP to the next week-start so W1 is always a full week inside the
    // lookback window. The trailing week still ends on `endDate` (typically
    // today), so the current in-progress week is shown as-is with whatever
    // partial data exists.
    let current = startOfWeek(startDate, { weekStartsOn });
    if (differenceInDays(startDate, current) > 0) {
      current = addWeeks(current, 1);
    }
    let weekNum = 1;

    while (!isAfter(current, endDate)) {
      const weekEnd = endOfWeek(current, { weekStartsOn });
      const periodEnd = isAfter(weekEnd, endDate) ? endDate : weekEnd;

      periods.push({
        label: `W${weekNum}`,
        start: format(current, "yyyy-MM-dd"),
        end: format(periodEnd, "yyyy-MM-dd"),
      });

      weekNum++;
      current = addWeeks(current, 1);
    }
  } else if (viewType === "monthly") {
    let current = startOfMonth(startDate);
    while (!isAfter(current, endDate)) {
      const monthEnd = endOfMonth(current);
      const periodEnd = isAfter(monthEnd, endDate) ? endDate : monthEnd;

      periods.push({
        label: format(current, "MMM yyyy"),
        start: format(current, "yyyy-MM-dd"),
        end: format(periodEnd, "yyyy-MM-dd"),
      });

      current = addMonths(current, 1);
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

// Fractional position within the current week, honoring the brand's configured
// week start. `day` is a 1-decimal value between 1.0 (week-start morning) and
// ~7.9 (last day just before rollover). `percent` is the raw float 0–100; the
// UI rounds it for display, while projection math uses the full precision.
export function getWeekProgress(
  weekStartsOn: WeekStartsOn = 0,
  now: Date = new Date()
): { day: number; percent: number } {
  const start = startOfWeek(now, { weekStartsOn });
  const end = endOfWeek(now, { weekStartsOn });
  const total = end.getTime() - start.getTime();
  const fraction = Math.min(
    1,
    Math.max(0, (now.getTime() - start.getTime()) / total)
  );
  const day = Math.min(7.9, Math.round((fraction * 7 + 1) * 10) / 10);
  const percent = fraction * 100;
  return { day, percent };
}

// `yyyy-MM-dd` for the user's local date. `Date#toISOString()` returns UTC, so
// it can roll over to "tomorrow" on the evening of the user's local day —
// avoid it for date inputs that should reflect what the user sees on the wall.
export function todayLocalISO(): string {
  return format(new Date(), "yyyy-MM-dd");
}

// Endpoint for "…through today" presets. Extended to today+1 so items whose
// stored published_date drifts a day into the future (UTC vs. local timezone)
// still appear in the range.
function rangeEnd(today: Date): Date {
  return addDays(today, 1);
}

export function getQuickRange(
  range: string
): { startDate: Date; endDate: Date } | null {
  const today = new Date();
  const endDate = rangeEnd(today);
  switch (range) {
    case "7d":
      return { startDate: subDays(today, 7), endDate };
    case "30d":
      return { startDate: subDays(today, 30), endDate };
    case "this-quarter":
      return { startDate: startOfQuarter(today), endDate };
    case "last-quarter": {
      const lastQ = subQuarters(today, 1);
      return { startDate: startOfQuarter(lastQ), endDate: endOfQuarter(lastQ) };
    }
    case "90d":
      return { startDate: subDays(today, 90), endDate };
    default:
      return null;
  }
}

export function alignToWeekBoundaries(
  startDate: Date,
  endDate: Date,
  weekStartsOn: WeekStartsOn = 0
): { startDate: Date; endDate: Date } {
  return {
    startDate: startOfWeek(startDate, { weekStartsOn }),
    endDate: endOfWeek(endDate, { weekStartsOn }),
  };
}
