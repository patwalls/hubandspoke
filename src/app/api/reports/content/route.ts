import { NextRequest, NextResponse } from "next/server";
import { getContentReportCached } from "@/lib/db/queries-cached";
import { format, subDays, differenceInDays, parseISO } from "date-fns";
import { todayInclusiveOfUtc } from "@/lib/dates";

// Range cap per granularity — bounds the period columns (and, with items,
// the item list). Monthly is capped only when items ride along, so "All
// time" on the dashboard really is all time.
const MAX_ITEMS_RANGE_DAYS = 730;
const MAX_RANGE_DAYS: Record<string, number> = {
  daily: 366,
  weekly: 730,
  monthly: Infinity,
};

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = todayInclusiveOfUtc();

  const requestedStart = searchParams.get("startDate") || defaultStart;
  let startDate = requestedStart;
  const endDate = searchParams.get("endDate") || defaultEnd;
  const viewType = (searchParams.get("viewType") || "weekly") as "weekly" | "daily" | "monthly";
  // The dashboard passes items=0 (aggregates only); the Content tab
  // omits it and gets the item list.
  const includeItems = searchParams.get("items") !== "0";

  // Clamp the date range to prevent OOM from unbounded queries.
  const maxDays = Math.min(
    MAX_RANGE_DAYS[viewType] ?? MAX_ITEMS_RANGE_DAYS,
    includeItems ? MAX_ITEMS_RANGE_DAYS : Infinity,
  );
  const rangeDays = differenceInDays(parseISO(endDate), parseISO(startDate));
  if (rangeDays > maxDays) {
    startDate = format(subDays(parseISO(endDate), maxDays), "yyyy-MM-dd");
  }

  const params = {
    brand: searchParams.get("brand") || "starter-story",
    startDate,
    endDate,
    viewType,
    platform: searchParams.get("platform") || "all",
    platformKey: searchParams.get("platformKey") || "all",
    accountId: searchParams.get("accountId") || "all",
    postType: searchParams.get("postType") || "all",
    format: searchParams.get("format") || "all",
    source: searchParams.get("source") || "all",
    provenOnly: searchParams.get("provenOnly") === "1",
    origin: searchParams.get("origin") || "all",
    includeItems,
  };

  try {
    const data = await getContentReportCached(params);
    // Tell the UI when it got less than it asked for, so a clamped "All
    // time" doesn't pass for the whole history.
    return NextResponse.json(
      startDate === requestedStart ? data : { ...data, clampedStartDate: startDate },
    );
  } catch (error) {
    console.error("Error generating content report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
