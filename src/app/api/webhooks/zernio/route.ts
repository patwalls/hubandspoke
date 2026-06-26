import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { verifyZernioSignature } from "@/lib/zernio";

// Zernio webhook fields aren't firmly documented; accept a tolerant shape.
// Documented post events: post.published, post.failed, post.partial,
// post.scheduled, post.cancelled, post.recycled. There is NO documented
// draft-specific event — our "delivered to inbox" state comes from the
// create-post 2xx, not a webhook. This receiver is cheap insurance: if a
// scheduled send fails INSIDE Zernio after acceptance, post.failed flips us
// to failed so the operator finds out.
interface ZernioWebhookPayload {
  event?: string;
  id?: string;
  post?: {
    _id?: string;
    status?: string;
    platforms?: Array<{
      platform?: string;
      platformPostUrl?: string | null;
      errorMessage?: string | null;
    }>;
  };
}

/**
 * Receive Zernio webhook events and keep the zernio* columns in sync.
 *
 * Configure in Zernio → Settings → Webhooks → URL:
 *   https://hubandspoke.starterstory.com/api/webhooks/zernio
 * Copy the signing secret into ZERNIO_WEBHOOK_SECRET.
 *
 * NOTE: Zernio's signature recipe is not firmly documented. Until it's
 * verified against a real delivery, a failed verify is logged but the event
 * is still processed (the only action is flipping our own status — low blast
 * radius). HARDEN to a 401 once the recipe is confirmed live.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  const signatureHeader = request.headers.get("X-Zernio-Signature");

  if (secret) {
    const ok = verifyZernioSignature({ rawBody, signatureHeader, secret });
    if (!ok) {
      console.warn(
        "[zernio-webhook] signature verify failed (recipe unverified — processing anyway)",
        JSON.stringify({
          hasSignature: !!signatureHeader,
          rawBodyLen: rawBody.length,
        }),
      );
    }
  }

  let payload: ZernioWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const postId = payload.post?._id ?? payload.id ?? null;
  if (!postId) {
    return NextResponse.json({ ok: true, ignored: "no post id" });
  }

  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.zernioPostId, postId))
    .limit(1);
  if (!item) {
    return NextResponse.json({ ok: true, ignored: "no matching item" });
  }

  if (payload.event === "post.failed") {
    const reason =
      payload.post?.platforms?.find((p) => p.errorMessage)?.errorMessage ??
      "Zernio reported the post failed";
    await db
      .update(productionItems)
      .set({
        zernioStatus: "failed",
        zernioError: reason.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(productionItems.id, item.id));
    return NextResponse.json({ ok: true });
  }

  if (payload.event === "post.published") {
    // The async publish landed. Capture the live URL and fold it into the
    // normal publish pipeline (real link + Published status) so the post is
    // treated like any other published item.
    const tiktok =
      payload.post?.platforms?.find((p) => p.platform === "tiktok") ??
      payload.post?.platforms?.[0];
    const liveUrl = tiktok?.platformPostUrl ?? null;
    const set: Record<string, unknown> = {
      zernioStatus: "published",
      zernioError: null,
      updatedAt: new Date(),
    };
    if (liveUrl) {
      set.publishedLink = liveUrl;
      set.status = "Published";
    }
    await db
      .update(productionItems)
      .set(set)
      .where(eq(productionItems.id, item.id));
    return NextResponse.json({ ok: true });
  }

  // Other events (scheduled / partial / cancelled / recycled) don't change
  // our model — ack so Zernio doesn't retry.
  return NextResponse.json({ ok: true, ignored: payload.event ?? "unknown" });
}
