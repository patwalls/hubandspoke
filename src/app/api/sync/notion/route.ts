import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guards";
import { syncFromNotion } from "@/lib/services/notion-sync";

export async function POST() {
  const guard = await requireAdmin();
  if (guard.response) return guard.response;
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
