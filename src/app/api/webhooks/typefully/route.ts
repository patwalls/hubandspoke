import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { productionItems } from "@/lib/db/schema";
import { verifyTypefullySignature } from "@/lib/typefully";

interface TypefullyWebhookPayload {
  event: string;
  data: {
    id: number;
    status?: string;
    scheduled_date?: string | null;
    published_at?: string | null;
    share_url?: string | null;
    private_url?: string | null;
  };
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
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: TypefullyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const draftId = payload.data?.id;
  if (typeof draftId !== "number") {
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
        typefullyStatus: payload.data.status ?? null,
        typefullyScheduledDate: payload.data.scheduled_date
          ? new Date(payload.data.scheduled_date)
          : null,
        typefullyPublishedAt: payload.data.published_at
          ? new Date(payload.data.published_at)
          : null,
        typefullyShareUrl: payload.data.share_url ?? null,
        typefullyPrivateUrl: payload.data.private_url ?? null,
      })
      .where(eq(productionItems.id, item.id));
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true, ignored: payload.event });
}
