import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { regenerateCtaForItem } from "@/lib/services/draft-algorithm/regenerate-cta";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Opus call + web_search server tool — typically 2–4s end-to-end. Same
// 60s headroom the main /draft route uses keeps cold-start variance from
// surfacing as a 504 in the UI.
export const maxDuration = 60;

/**
 * POST /api/production-items/[id]/regenerate-cta
 *
 * Regenerates ONLY the reply CTA (X reply tweet, LinkedIn first comment,
 * YouTube Community pinned comment). Preserves every other field in the
 * current draft — the body the editor hand-typed doesn't get clobbered,
 * unlike `/draft` (force=true) which rewrites the whole post.
 *
 * Returns:
 *   200 `{ status: "generated", draftId, ctaPreview }` on success.
 *   200 `{ status: "skipped", reason }` for benign skips
 *       (e.g. `no_cta_field` when the post type has no CTA slot).
 *   400 `{ error }` for user-actionable skips (no current draft, no post type).
 *   502 `{ error }` when the Opus call itself errored.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = (guard.session.user.id as string | undefined) ?? null;

  const { id } = await context.params;

  try {
    const result = await regenerateCtaForItem({
      productionItemId: id,
      actorUserId,
    });
    if (result.status === "skipped") {
      const userActionable =
        result.reason === "no_cta_field" ||
        result.reason === "no_current_draft" ||
        result.reason === "unsupported_post_type" ||
        result.reason === "item_not_found";
      if (userActionable) {
        return NextResponse.json(
          {
            status: "skipped",
            reason: result.reason,
            error: friendlyReason(result.reason),
          },
          { status: 400 },
        );
      }
      return NextResponse.json({ status: "skipped", reason: result.reason });
    }
    return NextResponse.json({
      status: "generated",
      draftId: result.draftId,
      ctaPreview: result.ctaPreview,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("regenerate-cta failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function friendlyReason(reason: string | undefined): string {
  switch (reason) {
    case "no_cta_field":
      return "This post type doesn't have a reply CTA slot.";
    case "no_current_draft":
      return "This item has no draft yet — start typing or click Regenerate on the main caption first.";
    case "unsupported_post_type":
      return "This item has no post type set.";
    case "item_not_found":
      return "Item not found.";
    default:
      return reason ?? "Unable to regenerate the CTA.";
  }
}
