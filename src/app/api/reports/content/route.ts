import { NextRequest, NextResponse } from "next/server";
import { getContentReport } from "@/lib/db/queries";
import { format, subDays } from "date-fns";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const today = new Date();
  const defaultStart = format(subDays(today, 90), "yyyy-MM-dd");
  const defaultEnd = format(today, "yyyy-MM-dd");

  const params = {
    brand: searchParams.get("brand") || "starter-story",
    startDate: searchParams.get("startDate") || defaultStart,
    endDate: searchParams.get("endDate") || defaultEnd,
    viewType: (searchParams.get("viewType") || "weekly") as "weekly" | "daily" | "monthly",
    platform: searchParams.get("platform") || "all",
    platformKey: searchParams.get("platformKey") || "all",
    accountId: searchParams.get("accountId") || "all",
    postType: searchParams.get("postType") || "all",
    format: searchParams.get("format") || "all",
    source: searchParams.get("source") || "all",
  };

  try {
    const data = await getContentReport(params);
    return NextResponse.json(data);
  } catch (error) {
    console.error("Error generating content report:", error);
    return NextResponse.json(
      { error: "Failed to generate report" },
      { status: 500 }
    );
  }
}
