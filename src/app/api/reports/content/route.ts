import { NextRequest, NextResponse } from "next/server";
import { getContentReportCached } from "@/lib/db/queries-cached";
import { format, subDays, differenceInDays, parseISO } from "date-fns";
import { todayInclusiveOfUtc } from "@/lib/dates";

const MAX_DATE_RANGE_DAYS = 730;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = todayInclusiveOfUtc();

  let startDate = searchParams.get("startDate") || defaultStart;
  const endDate = searchParams.get("endDate") || defaultEnd;

  // Clamp the date range to prevent OOM from unbounded queries.
  const rangeDays = differenceInDays(parseISO(endDate), parseISO(startDate));
  if (rangeDays > MAX_DATE_RANGE_DAYS) {
    startDate = format(subDays(parseISO(endDate), MAX_DATE_RANGE_DAYS), "yyyy-MM-dd");
  }

  const params = {
    brand: searchParams.get("brand") || "starter-story",
    startDate,
    endDate,
    viewType: (searchParams.get("viewType") || "weekly") as "weekly" | "daily" | "monthly",
    platform: searchParams.get("platform") || "all",
    platformKey: searchParams.get("platformKey") || "all",
    accountId: searchParams.get("accountId") || "all",
    postType: searchParams.get("postType") || "all",
    format: searchParams.get("format") || "all",
    source: searchParams.get("source") || "all",
    provenOnly: searchParams.get("provenOnly") === "1",
    origin: searchParams.get("origin") || "all",
  };

  try {
    const data = await getContentReportCached(params);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error generating content report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
