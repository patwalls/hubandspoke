import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { listAccounts } from "@/lib/zernio";
import { verifyConnectState } from "@/lib/services/tiktok-draft/connect-state";
import { CONNECT_STATE_COOKIE } from "../connect/route";

/**
 * Zernio OAuth callback. Zernio completed the TikTok token exchange on its
 * side and redirected here, appending (standard mode)
 * `?connected=tiktok&accountId=<id>&username=<handle>`.
 *
 * We:
 *  1. verify the signed state cookie → the hubandspoke account we're binding,
 *  2. read the new Zernio ConnectedAccount `_id` from the query (param casing
 *     is unverified, so we read a few aliases), falling back to listAccounts,
 *  3. stamp `accounts.zernioAccountId`,
 *  4. redirect back to the brand Accounts page with a status flag.
 *
 * Then a human can send TikTok drafts for this account from the content page.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const url = request.nextUrl;
  const cookie = request.cookies.get(CONNECT_STATE_COOKIE)?.value ?? null;
  const boundAccountId = verifyConnectState(cookie);

  const back = (status: string) => {
    const res = NextResponse.redirect(
      new URL(`/?tiktokConnect=${status}`, url.origin),
    );
    res.cookies.delete(CONNECT_STATE_COOKIE);
    return res;
  };

  if (!boundAccountId) {
    return back("invalid_state");
  }

  // Confirm the hubandspoke account still exists and is TikTok.
  const [acct] = await db
    .select({ id: accounts.id, platform: accounts.platform })
    .from(accounts)
    .where(eq(accounts.id, boundAccountId))
    .limit(1);
  if (!acct || acct.platform !== "tiktok") {
    return back("invalid_account");
  }

  // Zernio echoes the new account id on the standard-mode redirect. Casing is
  // unverified — accept a few aliases. If absent, the user likely declined, or
  // the param shape differs; fall back to listing TikTok accounts.
  let zernioAccountId =
    url.searchParams.get("accountId") ||
    url.searchParams.get("account_id") ||
    url.searchParams.get("connectedAccountId") ||
    null;

  if (!zernioAccountId) {
    try {
      const tiktokAccounts = await listAccounts({ platform: "tiktok" });
      // One TikTok account under our single profile → unambiguous. If there
      // are several, we can't safely guess which is new — surface an error.
      if (tiktokAccounts.length === 1) {
        zernioAccountId = tiktokAccounts[0]._id;
      }
    } catch {
      // fall through to error
    }
  }

  if (!zernioAccountId) {
    return back("no_account");
  }

  await db
    .update(accounts)
    .set({ zernioAccountId, updatedAt: new Date() })
    .where(eq(accounts.id, boundAccountId));

  return back("connected");
}
