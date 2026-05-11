import { NextRequest, NextResponse } from "next/server";
import { mergeProductionItems } from "@/lib/services/merge-production-items";
import { requireSession } from "@/lib/auth-guards";

interface MergeRequest {
  primaryId: string;
  secondaryId: string;
  mergeStrategy: "keepPrimary" | "keepSecondary" | "mergeMetrics";
}

/**
 * Merge two duplicate production items.
 *
 * Request body:
 * {
 *   primaryId: string,      // Item to keep
 *   secondaryId: string,    // Item to merge into primary
 *   mergeStrategy: string   // "keepPrimary" | "keepSecondary" | "mergeMetrics"
 * }
 *
 * Strategies:
 * - keepPrimary: Keep primary's data, soft-delete secondary
 * - keepSecondary: Use secondary's data, soft-delete it anyway (data moved to primary)
 * - mergeMetrics: Keep primary's structure, sum views from both
 *
 * Response:
 * {
 *   success: boolean,
 *   message: string,
 *   primaryId: string,
 *   secondaryId: string,
 *   deletedId: string
 * }
 */
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const userId = guard.session.user.id;

  try {
    const body = (await request.json()) as MergeRequest;
    const { primaryId, secondaryId, mergeStrategy } = body;

    // Validate required fields
    if (!primaryId || !secondaryId || !mergeStrategy) {
      return NextResponse.json(
        { error: "Missing required fields: primaryId, secondaryId, mergeStrategy" },
        { status: 400 }
      );
    }

    // Validate merge strategy
    if (!["keepPrimary", "keepSecondary", "mergeMetrics"].includes(mergeStrategy)) {
      return NextResponse.json(
        { error: "Invalid mergeStrategy. Must be one of: keepPrimary, keepSecondary, mergeMetrics" },
        { status: 400 }
      );
    }

    // Perform the merge
    const result = await mergeProductionItems(
      primaryId,
      secondaryId,
      mergeStrategy as "keepPrimary" | "keepSecondary" | "mergeMetrics",
      userId
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error("[merge-api] error:", err);
    return NextResponse.json(
      { error: "Failed to merge items" },
      { status: 500 }
    );
  }
}
