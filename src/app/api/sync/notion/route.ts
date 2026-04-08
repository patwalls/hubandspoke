import { NextResponse } from "next/server";
import { syncFromNotion } from "@/lib/services/notion-sync";

export async function POST() {
  try {
    const result = await syncFromNotion();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Notion sync error:", error);
    return NextResponse.json(
      { error: "Sync failed", success: false },
      { status: 500 }
    );
  }
}
