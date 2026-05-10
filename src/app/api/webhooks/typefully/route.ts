import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { verifyTypefullySignature } from "@/lib/typefully";

// Short SHA-256 prefix of the secret. Lets us tell two configured secrets
// apart in logs (so we can spot a Typefully-side rotation) without
// printing the secret itself.
function createHashShort(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

// Typefully sends webhook fields FLAT — `event`, `id`, `status`,
// `share_url`, `private_url`, `scheduled_date`, `published_at`, etc.
// all live at the top level alongside one block per network
// (twitter / threads / linkedin / bluesky / mastodon). Earlier code
// here expected `{ event, data: {...} }` and silently ignored every
// delivery as "no draft id" — fixed 2026-05-10 after Typefully's
// dashboard request log made the actual shape visible.
interface TypefullyWebhookPayload {
  event: string;
  id?: number;
  // Some events also expose `draft_id` (same number); accept either.
  draft_id?: number;
  status?: string;
  scheduled_date?: string | null;
  published_at?: string | null;
  share_url?: string | null;
  private_url?: string | null;
}

/**
 * Receive Typefully webhook events and keep the productionItems Typefully
 * columns in sync. Subscribed events: draft.status_changed, draft.scheduled,
 * draft.published, draft.deleted. Other events are ack'd with 200 so
 * Typefully doesn't retry forever.
 *
 * Configure in Typefully settings → Webhooks → URL:
 *   https://hubandspoke.starterstory.com/api/webhooks/typefully
 * (NOT hubandspoke.herokuapp.com — that hostname doesn't exist; the
 *  Heroku-assigned domain uses the modern hashed pattern. The custom
 *  prod domain is more durable than the hashed one anyway.)
 * Copy the generated secret into TYPEFULLY_WEBHOOK_SECRET.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.TYPEFULLY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[typefully-webhook] TYPEFULLY_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const timestamp = request.headers.get("X-Typefully-Timestamp");
  const signatureHeader = request.headers.get("X-Typefully-Signature");

  if (
    !verifyTypefullySignature({
      rawBody,
      timestamp,
      signatureHeader,
      secret,
    })
  ) {
    // Log enough to diagnose without leaking the secret. Shipped after
    // Typefully disabled the webhook for the SECOND time after 100
    // 401s — we couldn't tell whether the headers were missing, the
    // recipe drifted, or the secret was rotated upstream. Log: header
    // presence, lengths, and a SHA-prefix of the secret so we can spot
    // a mismatch after a Typefully-side regenerate.
    const secretFingerprint = createHashShort(secret);
    console.warn(
      "[typefully-webhook] signature verify failed",
      JSON.stringify({
        hasTimestamp: !!timestamp,
        hasSignature: !!signatureHeader,
        signatureLen: signatureHeader?.length ?? 0,
        rawBodyLen: rawBody.length,
        secretFingerprint,
        // Useful when Typefully renames a header — surfaces what they
        // actually sent so we can fix the recipe.
        typefullyHeaderNames: Array.from(request.headers.keys())
          .filter((h) => h.toLowerCase().includes("typefully"))
          .join(","),
      }),
    );
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: TypefullyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const draftId =
    typeof payload.id === "number"
      ? payload.id
      : typeof payload.draft_id === "number"
        ? payload.draft_id
        : null;
  if (draftId == null) {
    return NextResponse.json({ ok: true, ignored: "no draft id" });
  }

  // Find the production item that owns this Typefully draft. If none, the
  // draft was created outside hubandspoke or already deleted on our side —
  // ack and move on.
  const [item] = await db
    .select({ id: productionItems.id })
    .from(productionItems)
    .where(eq(productionItems.typefullyDraftId, draftId))
    .limit(1);
  if (!item) {
    return NextResponse.json({ ok: true, ignored: "no matching item" });
  }

  if (payload.event === "draft.deleted") {
    await db
      .update(productionItems)
      .set({
        typefullyDraftId: null,
        typefullyStatus: null,
        typefullyShareUrl: null,
        typefullyPrivateUrl: null,
        typefullyScheduledDate: null,
        typefullyPublishedAt: null,
        typefullyError: null,
      })
      .where(eq(productionItems.id, item.id));
    return NextResponse.json({ ok: true });
  }

  if (
    payload.event === "draft.status_changed" ||
    payload.event === "draft.scheduled" ||
    payload.event === "draft.published"
  ) {
    await db
      .update(productionItems)
      .set({
        typefullyStatus: payload.status ?? null,
        typefullyScheduledDate: payload.scheduled_date
          ? new Date(payload.scheduled_date)
          : null,
        typefullyPublishedAt: payload.published_at
          ? new Date(payload.published_at)
          : null,
        typefullyShareUrl: payload.share_url ?? null,
        typefullyPrivateUrl: payload.private_url ?? null,
      })
      .where(eq(productionItems.id, item.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: payload.event });
}
