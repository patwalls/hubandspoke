import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { enqueue } from "@/jobs/enqueue";
import {
  verifyFeedhookSignature,
  feedhookSyncEnabled,
  type FeedhookEvent,
} from "@/lib/feedhook";

/**
 * Feedhook push receiver — replaces "poll Scrape Creators every 10 minutes"
 * with "Feedhook tells us the moment an account posts". On a verified
 * video.published / post.published event we enqueue the existing
 * `account-content-sync` task (mode=latest) for the matching account, which
 * pulls the fresh timeline and upserts the new post exactly like the polling
 * sweep does — same dedup keys, same reconciler downstream, so duplicate
 * deliveries are harmless.
 *
 * DARK until cutover:
 *   - No subscriptions exist until scripts/feedhook-subscribe.mjs runs, so
 *     nothing POSTs here.
 *   - Even then, FEEDHOOK_SYNC_ENABLED must be set before deliveries enqueue
 *     anything — unset, we verify + ack + log only.
 *
 * Feedhook contract: answer 2xx within 15s or it retries (8 attempts / ~9h).
 * Always ack verified deliveries — even unmatched ones — so a stale
 * subscription can't clog Feedhook's retry queue; we log those instead.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.FEEDHOOK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[feedhook-webhook] FEEDHOOK_WEBHOOK_SECRET not set");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-feedhook-signature");
  if (!verifyFeedhookSignature({ rawBody, signatureHeader, secret })) {
    console.warn("[feedhook-webhook] rejected delivery with bad signature");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: FeedhookEvent;
  try {
    event = JSON.parse(rawBody) as FeedhookEvent;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (event.event === "test.ping") {
    console.log(`[feedhook-webhook] test.ping ok sub=${event.subscriptionId}`);
    return NextResponse.json({ ok: true, test: true });
  }
  if (event.event !== "video.published" && event.event !== "post.published") {
    // Unknown-but-signed event type — ack so Feedhook doesn't retry forever.
    console.log(`[feedhook-webhook] ignoring event=${event.event}`);
    return NextResponse.json({ ok: true, ignored: event.event });
  }

  const [account] = await db
    .select({ id: accounts.id, handle: accounts.handle, platform: accounts.platform })
    .from(accounts)
    .where(
      and(
        eq(accounts.feedhookSubscriptionId, event.subscriptionId),
        isNull(accounts.deletedAt)
      )
    )
    .limit(1);

  if (!account) {
    console.warn(
      `[feedhook-webhook] no account for subscription ${event.subscriptionId} (event=${event.event}) — ack'd, not synced`
    );
    return NextResponse.json({ ok: true, matched: false });
  }

  if (!feedhookSyncEnabled()) {
    console.log(
      `[feedhook-webhook] DARK: would sync ${account.platform}/@${account.handle} for ${event.event} ${event.url ?? event.videoId ?? event.postId ?? ""} (FEEDHOOK_SYNC_ENABLED unset)`
    );
    return NextResponse.json({ ok: true, matched: true, dark: true });
  }

  await enqueue("account-content-sync", { accountId: account.id, mode: "latest" });
  console.log(
    `[feedhook-webhook] enqueued account-content-sync for ${account.platform}/@${account.handle} (${event.event})`
  );
  return NextResponse.json({ ok: true, matched: true, enqueued: true });
}
