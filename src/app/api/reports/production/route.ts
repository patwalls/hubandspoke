import { NextRequest, NextResponse } from "next/server";
import { getProductionPipeline } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "starter-story";

  try {
    const items = await getProductionPipeline(brand);
    return NextResponse.json({ items });
  } catch (error) {
    console.error("Error generating production pipeline:", error);
    return NextResponse.json(
      { error: "Failed to generate production pipeline" },
      { status: 500 }
    );
  }
}
