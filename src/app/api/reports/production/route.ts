import { NextRequest, NextResponse } from "next/server";
import { getProductionPipeline } from "@/lib/db/queries";
import {
  buildViewPredictorContext,
  predictViews,
} from "@/lib/services/view-predictor";

export async function GET(request: NextRequest) {
  const brand = request.nextUrl.searchParams.get("brand") || "starter-story";

  try {
    const [items, ctx] = await Promise.all([
      getProductionPipeline(brand),
      buildViewPredictorContext(brand),
    ]);
    const withPredictions = items.map((item) => {
      if (item.status === "Published") return item;
      const prediction = predictViews(
        {
          id: item.id,
          format: item.format,
          platforms: item.platform,
          pillarContentItemId: item.pillarContentItemId ?? null,
        },
        ctx
      );
      return { ...item, prediction };
    });
    return NextResponse.json({ items: withPredictions });
  } catch (error) {
    console.error("Error generating production pipeline:", error);
    return NextResponse.json(
      { error: "Failed to generate production pipeline" },
      { status: 500 }
    );
  }
}
