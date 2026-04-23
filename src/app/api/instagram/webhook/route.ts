import { NextRequest, NextResponse } from "next/server";
import { findKeywordMatch } from "@/lib/services/manychat";
import {
  sendInstagramPrivateReply,
  verifyMetaSignature,
} from "@/lib/services/instagram";

export const dynamic = "force-dynamic";

/**
 * GET /api/instagram/webhook
 *
 * Meta's webhook subscription handshake. When configuring the subscription in
 * the Meta App Dashboard, Meta hits this URL with hub.mode=subscribe,
 * hub.verify_token=<our token>, hub.challenge=<random>. We must echo
 * hub.challenge back as plain text on a 200 response.
 */
export async function GET(request: NextRequest) {
  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    console.error("[instagram/webhook] META_VERIFY_TOKEN not set");
    return new NextResponse("server misconfigured", { status: 500 });
  }
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === expected && challenge) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  return new NextResponse("forbidden", { status: 403 });
}

// Comment webhook payload shape (the slice we care about). Meta sends a
// batch with `entry[].changes[]`, each change has `field` and `value`. We
// only act on `field === "comments"`.
type CommentChangeValue = {
  id?: string;        // comment_id
  text?: string;      // the comment body
  from?: { id?: string; username?: string };
  media?: { id?: string };
};

/**
 * POST /api/instagram/webhook
 *
 * Comment event handler. Meta delivers an event for every comment on any post
 * we're subscribed to. We:
 *   1. Verify the X-Hub-Signature-256 HMAC against the raw body.
 *   2. Iterate each comment change in the payload.
 *   3. Skip self-comments (where from.id == our IG business ID).
 *   4. Look up the comment text in our DB. If matched, send a private reply
 *      with the configured link.
 *   5. Always respond 200 (Meta retries on non-2xx; failures should be logged
 *      not surfaced as errors to Meta).
 *
 * Each change is processed independently — one bad comment_id doesn't fail
 * the batch.
 */
export async function POST(request: NextRequest) {
  // Read the body as raw text BEFORE parsing — the signature is over the
  // exact bytes Meta sent, and re-stringifying after JSON.parse would change
  // whitespace/key order and break verification.
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyMetaSignature(rawBody, signature)) {
    console.warn("[instagram/webhook] signature verification failed");
    return new NextResponse("forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[instagram/webhook] body is not valid JSON");
    return new NextResponse("ok", { status: 200 });
  }

  const ourBusinessId = process.env.INSTAGRAM_BUSINESS_ID;

  // Walk the Meta envelope. Defensive: any field could be missing.
  const entries =
    payload && typeof payload === "object" && "entry" in payload
      ? ((payload as { entry: unknown }).entry as unknown[])
      : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = "changes" in entry ? ((entry as { changes: unknown }).changes as unknown[]) : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const field = "field" in change ? (change as { field: unknown }).field : null;
      if (field !== "comments") continue;
      const value =
        "value" in change ? ((change as { value: unknown }).value as CommentChangeValue) : null;
      if (!value) continue;

      const commentId = value.id ?? "";
      const commentText = value.text ?? "";
      const fromId = value.from?.id ?? "";
      const fromUsername = value.from?.username ?? "";

      if (!commentId) {
        console.log("[instagram/webhook] skipping comment with no id");
        continue;
      }
      if (ourBusinessId && fromId === ourBusinessId) {
        // Don't reply to our own comments.
        continue;
      }

      const match = await findKeywordMatch(commentText);
      console.log(
        `[instagram/webhook] comment_id=${commentId} from=@${fromUsername} text=${JSON.stringify(commentText)} match=${match ? "yes" : "no"}`
      );
      if (!match) continue;

      const message = `Here's the link from "${match.post_title}":\n\n${match.link}`;
      const result = await sendInstagramPrivateReply(commentId, message);
      if (!result.ok) {
        console.error(
          `[instagram/webhook] DM send failed comment_id=${commentId} status=${result.status} error=${result.error}`
        );
      } else {
        console.log(
          `[instagram/webhook] DM sent comment_id=${commentId} message_id=${result.messageId}`
        );
      }
    }
  }

  return new NextResponse("ok", { status: 200 });
}
