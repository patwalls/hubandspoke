import { NextRequest, NextResponse } from "next/server";
import { mergeProductionItems } from "@/lib/services/merge-production-items";
import { requireSession } from "@/lib/auth-guards";

interface MergeRequest {
  primaryId: string;
  secondaryId: string;
}

/**
 * Merge two duplicate production items.
 *
 * Request body:
 * {
 *   primaryId: string,      // Item to keep (the one with editor metadata/comments)
 *   secondaryId: string,    // Item to merge and delete (the duplicate pulled by API)
 * }
 *
 * Smart merge behavior:
 * - Primary item keeps: editor metadata, sourceType, format, title, comments, history
 * - Primary item receives: platformContentId, publishedLink, and summed metrics from secondary
 * - Secondary item is soft-deleted
 * - Future API syncs will find and update the primary item
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
    const { primaryId, secondaryId } = body;

    // Validate required fields
    if (!primaryId || !secondaryId) {
      return NextResponse.json(
        { error: "Missing required fields: primaryId, secondaryId" },
        { status: 400 }
      );
    }

    // Perform the merge
    const result = await mergeProductionItems(
      primaryId,
      secondaryId,
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
