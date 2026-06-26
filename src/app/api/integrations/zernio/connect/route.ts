import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { getConnectUrl } from "@/lib/zernio";
import { signConnectState } from "@/lib/services/tiktok-draft/connect-state";

export const CONNECT_STATE_COOKIE = "zernio_connect_state";

/**
 * Start the Zernio OAuth flow to connect a TikTok account.
 *
 *   GET /api/integrations/zernio/connect?accountId=<hubandspoke account id>
 *
 * We carry the signed state (which account we're binding + CSRF) in an
 * httpOnly cookie rather than the redirect URL: Zernio appends its own
 * `?connected=…&accountId=…` to the redirect_url, and a query we'd added
 * there could collide. The callback reads the cookie back.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const accountId = request.nextUrl.searchParams.get("accountId");
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }

  const [acct] = await db
    .select({ id: accounts.id, platform: accounts.platform })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!acct) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (acct.platform !== "tiktok") {
    return NextResponse.json(
      { error: "Only TikTok accounts can be connected to Zernio." },
      { status: 400 },
    );
  }

  const callbackUrl = new URL(
    "/api/integrations/zernio/callback",
    request.nextUrl.origin,
  ).toString();

  let authUrl: string;
  try {
    authUrl = await getConnectUrl({ platform: "tiktok", redirectUrl: callbackUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Zernio connect failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(CONNECT_STATE_COOKIE, signConnectState(accountId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
  return res;
}
