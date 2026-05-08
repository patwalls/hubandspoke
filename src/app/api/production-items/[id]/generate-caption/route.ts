import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { generateInstagramCaptionForItem } from "@/lib/services/generate-instagram-caption";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Opus call is ~5–10s; allow headroom for cold-start or slow transcripts.
export const maxDuration = 60;

/**
 * POST /api/production-items/[id]/generate-caption
 *
 * Manual trigger for the Instagram caption-generation primitive. The
 * Regenerate button on the simulator caption panel POSTs here.
 *
 * - Body: `{ force?: boolean }`. `force=true` overrides the
 *   "already-filled" guard — needed when an editor clicks Regenerate on a
 *   caption that's already been touched.
 * - 200 with `{ status, draftId?, captionPreview? }` on success.
 * - 400 with `{ error }` for the user-actionable cases (no transcript,
 *   non-IG post type) so the caller can surface a friendly toast.
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
    const result = await generateInstagramCaptionForItem(id, {
      force: !!body.force,
      actorUserId,
    });
    if (result.status === "skipped") {
      // 200 with the skip reason — the UI distinguishes via response.status.
      const userActionable =
        result.reason === "no_transcript" ||
        result.reason === "not_instagram" ||
        result.reason === "no_platform_schema";
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("generate-caption failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function friendlyReason(reason: string | undefined): string {
  switch (reason) {
    case "no_transcript":
      return "No transcript available for this item's pillar. Fetch the transcript first.";
    case "not_instagram":
      return "Caption generation is only supported on Instagram post types.";
    case "no_platform_schema":
      return "This item has no platform — pick one before generating a caption.";
    default:
      return reason ?? "Unable to generate caption.";
  }
}
