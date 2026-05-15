import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { runDraftAlgorithm } from "@/lib/services/draft-algorithm/run";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Opus call is ~5–10s; allow headroom for cold-start or slow transcripts.
export const maxDuration = 60;

/**
 * POST /api/production-items/[id]/draft
 *
 * Manual entry point for the Draft Algorithm. Regenerate buttons across
 * the simulator panels POST here.
 *
 * - Body: `{ force?: boolean }`. `force=true` overrides the
 *   "already-filled" guard — needed when an editor clicks Regenerate on a
 *   draft that's already been touched.
 * - 200 with `{ status, draftId?, captionPreview? }` on success.
 * - 400 with `{ error }` for the user-actionable cases (no transcript,
 *   unsupported post type) so the caller can surface a friendly toast.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const actorUserId = guard.session.user.id ?? null;

  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as {
    force?: boolean;
  };

  try {
    const result = await runDraftAlgorithm(id, {
      force: !!body.force,
      actorUserId,
    });
    if (result.status === "skipped") {
      const userActionable =
        result.reason === "no_substrate" ||
        result.reason === "unsupported_post_type" ||
        result.reason === "no_platform_schema" ||
        result.reason === "no_caption_field";
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
      return NextResponse.json({
        status: "skipped",
        reason: result.reason,
      });
    }
    return NextResponse.json({
      status: "generated",
      draftId: result.draftId,
      captionPreview: result.captionPreview,
      descriptStep: result.descriptStep,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("draft-algorithm failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function friendlyReason(reason: string | undefined): string {
  switch (reason) {
    case "no_substrate":
      return "No transcript, body, or title is available on this item's source. Fetch the transcript or fill in a caption on the source post first.";
    case "unsupported_post_type":
      return "Draft generation isn't supported for this post type yet.";
    case "no_platform_schema":
      return "This item has no platform schema — pick a post type before generating.";
    case "no_caption_field":
      return "This post type has no caption field configured.";
    default:
      return reason ?? "Unable to generate draft.";
  }
}
