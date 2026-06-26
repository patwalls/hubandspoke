import { createHmac, timingSafeEqual } from "node:crypto";

// Signed, expiring state token for the Zernio OAuth round-trip. Carries which
// hubandspoke `accounts.id` we're binding the connected TikTok account to, and
// protects the callback against CSRF / tampering. Signed with AUTH_SECRET
// (the same secret Auth.js uses), so no new env var.

const TTL_MS = 15 * 60 * 1000; // OAuth dance should complete well within 15m.

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.CRON_SECRET;
  if (!s) throw new Error("AUTH_SECRET not set (needed to sign OAuth state)");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Build a signed state token binding this OAuth flow to `accountId`. */
export function signConnectState(accountId: string): string {
  const payload = b64url(
    Buffer.from(JSON.stringify({ accountId, exp: Date.now() + TTL_MS })),
  );
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify a state token. Returns the bound accountId, or null if the token is
 *  malformed, tampered, or expired. */
export function verifyConnectState(token: string | null): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { accountId, exp } = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as { accountId?: string; exp?: number };
    if (!accountId || !exp || Date.now() > exp) return null;
    return accountId;
  } catch {
    return null;
  }
}
