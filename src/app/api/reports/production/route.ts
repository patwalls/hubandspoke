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
      // For clip rows, prefer the LLM's per-clip estimate over the generic
      // format-based predictor. The LLM reads the actual transcript chunk
      // and the brand's top-performer hooks, so it has strictly more signal
      // than the format median. Wrap it into the same ViewPrediction shape
      // so the UI doesn't need a special-case render path.
      if (
        item.sourceClipIdeaId != null &&
        item.clipEstimatedViews != null &&
        prediction
      ) {
        const est = item.clipEstimatedViews;
        return {
          ...item,
          prediction: {
            ...prediction,
            prediction: est,
            p25: est,
            p75: est,
            confidence: "high" as const,
            cohortBreakdown: [],
          },
        };
      }
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
