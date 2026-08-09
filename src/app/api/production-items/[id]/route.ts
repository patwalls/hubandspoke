import { NextRequest, NextResponse } from "next/server";
import { getProductionItemDetail } from "@/lib/services/production-item-detail";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Thin envelope over the extracted service — see
// src/lib/services/production-item-detail.ts for why it lives there
// (SSR by the detail page + boot warming + this route all share it).
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const payload = await getProductionItemDetail(id);
    if (!payload) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }
    return NextResponse.json(payload);
  } catch (error) {
    console.error("Error fetching production item:", error);
    return NextResponse.json(
      { error: "Failed to fetch item" },
      { status: 500 }
    );
  }
}
