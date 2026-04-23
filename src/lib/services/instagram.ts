// Instagram Graph API client — comment-to-DM dispatcher.
//
// Used by /api/instagram/webhook. Replaces ManyChat as the dispatcher for
// IG comment → DM, since ManyChat's External Request can't see the actual
// comment text. Meta's webhook delivers the comment text + media ID +
// commenter ID directly, and Meta's "private reply" Send API endpoint
// bypasses the 24-hour messaging window for the FIRST DM in response to a
// specific comment_id.
//
// Auth: long-lived Page Access Token (env INSTAGRAM_PAGE_ACCESS_TOKEN).
// Webhook signature verification: HMAC-SHA256 with META_APP_SECRET (Meta
// signs all inbound webhooks with X-Hub-Signature-256).

import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = "v25.0";
const SEND_ENDPOINT = `https://graph.instagram.com/${GRAPH_VERSION}/me/messages`;

type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; status: number; error: string };

async function postToSendApi(body: object): Promise<SendResult> {
  const token = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (!token) {
    return {
      ok: false,
      status: 500,
      error: "INSTAGRAM_PAGE_ACCESS_TOKEN not set",
    };
  }

  const res = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Meta returns { message_id, recipient_id } on success or { error: { message,
  // type, code, ... } } on failure. Always JSON either way.
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { ok: false, status: res.status, error: "non-JSON response" };
  }

  if (!res.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? JSON.stringify((payload as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error };
  }

  const messageId =
    payload && typeof payload === "object" && "message_id" in payload
      ? String((payload as { message_id: unknown }).message_id)
      : "";
  return { ok: true, messageId };
}

/**
 * Send a private reply to a specific comment via the Instagram Send API.
 * The `comment_id` recipient form bypasses the 24-hour messaging window —
 * but it's a one-shot per comment per commenter, and only valid for 7 days
 * after the comment was posted.
 */
export function sendInstagramPrivateReply(
  commentId: string,
  message: string
): Promise<SendResult> {
  return postToSendApi({
    recipient: { comment_id: commentId },
    message: { text: message },
  });
}

/**
 * Send a standard DM to an Instagram user by their IGSID. Subject to the
 * 24-hour messaging window — only call this in response to an inbound message
 * from that user (which is the only path that uses this in the webhook).
 */
export function sendInstagramDirectMessage(
  recipientIgsid: string,
  message: string
): Promise<SendResult> {
  return postToSendApi({
    recipient: { id: recipientIgsid },
    message: { text: message },
  });
}

/**
 * Verify Meta's X-Hub-Signature-256 header against the raw request body.
 * Meta signs all webhook deliveries with HMAC-SHA256 using the App Secret as
 * the key. We must use the RAW body (the bytes Meta sent), not a re-serialized
 * version of the parsed JSON — even an extra space breaks the signature.
 *
 * Returns true if the signature is valid, false otherwise (or if the signature
 * header is missing, malformed, or APP_SECRET isn't set).
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null
): boolean {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    console.error("[instagram] META_APP_SECRET not set — refusing webhook");
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  // Length check first — timingSafeEqual throws on mismatched lengths, and the
  // throw itself leaks timing info. Bail before getting there.
  if (expected.length !== received.length) return false;

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  } catch {
    return false;
  }
}
