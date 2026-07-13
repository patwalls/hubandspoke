/**
 * Feedhook (feedhook.walls.sh) — signature verification + event types for the
 * /api/webhooks/feedhook receiver. Feedhook pushes a signed JSON POST when a
 * watched account publishes: `video.published` for YouTube channels (WebSub
 * push, ~8s latency), `post.published` for polled platforms (x / instagram /
 * tiktok, ~10 min latency).
 *
 * Every subscription hubandspoke creates (scripts/feedhook-subscribe.mjs)
 * supplies the SAME signing secret — FEEDHOOK_WEBHOOK_SECRET — so this
 * receiver verifies the whole fleet with one env var.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** `x-feedhook-signature: sha256=<hex HMAC-SHA256(raw body, secret)>` */
export function verifyFeedhookSignature(params: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  const { rawBody, signatureHeader, secret } = params;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const got = signatureHeader.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export interface FeedhookEvent {
  event: "video.published" | "post.published" | "test.ping" | string;
  subscriptionId: string;
  /** post.published only — "x" | "instagram" | "tiktok" | "facebook" */
  platform?: string;
  /** post.published */
  postId?: string;
  /** video.published */
  videoId?: string;
  channelId?: string;
  url?: string | null;
  title?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  receivedAt?: string;
  test?: boolean;
}

/** Master switch: unset (the default, DARK) → the receiver verifies + acks
 *  deliveries but changes no state. */
export function feedhookSyncEnabled(): boolean {
  const v = (process.env.FEEDHOOK_SYNC_ENABLED || "").toLowerCase();
  return v === "1" || v === "true";
}
