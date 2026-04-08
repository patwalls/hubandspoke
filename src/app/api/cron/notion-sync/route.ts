import { NextRequest, NextResponse } from "next/server";
import { syncFromNotion } from "@/lib/services/notion-sync";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncFromNotion();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Cron notion sync error:", error);
    return NextResponse.json(
      { error: "Sync failed", success: false },
      { status: 500 }
    );
  }
}
