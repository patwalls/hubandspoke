import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brands } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { listAccounts } from "@/lib/zernio";
import { verifyConnectState } from "@/lib/services/tiktok-draft/connect-state";
import {
  matchZernioAccount,
  type ConnectStatus,
} from "@/lib/services/tiktok-draft/connect-match";
import { CONNECT_STATE_COOKIE } from "../connect/route";

/**
 * Zernio OAuth callback. Zernio completed the TikTok token exchange on its
 * side and redirected here, appending (standard mode)
 * `?connected=tiktok&accountId=<id>&username=<handle>`.
 *
 * We:
 *  1. verify the signed state cookie → the hubandspoke account we're binding,
 *  2. list the profile's TikTok accounts and pick the one whose username is
 *     this account's handle (connect-match.ts — the echoed id is only a
 *     tie-breaker; the TikTok login used may not be the account clicked),
 *  3. stamp `accounts.zernioAccountId`,
 *  4. redirect back to that brand's Accounts page with a status flag, which
 *     the page shows as a banner.
 *
 * Then a human can send TikTok drafts for this account from the content page.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const url = request.nextUrl;
  const cookie = request.cookies.get(CONNECT_STATE_COOKIE)?.value ?? null;
  const boundAccountId = verifyConnectState(cookie);

  const back = (
    status: ConnectStatus,
    opts: { brandSlug?: string | null; connectedAs?: string | null } = {},
  ) => {
    const dest = new URL(
      opts.brandSlug ? `/${opts.brandSlug}/accounts` : "/",
      url.origin,
    );
    dest.searchParams.set("tiktokConnect", status);
    if (boundAccountId) dest.searchParams.set("account", boundAccountId);
    if (opts.connectedAs) dest.searchParams.set("connectedAs", opts.connectedAs);
    const res = NextResponse.redirect(dest);
    res.cookies.delete(CONNECT_STATE_COOKIE);
    return res;
  };

  if (!boundAccountId) {
    return back("invalid_state");
  }

  // Confirm the hubandspoke account still exists and is TikTok.
  const [acct] = await db
    .select({
      id: accounts.id,
      platform: accounts.platform,
      handle: accounts.handle,
      brandSlug: brands.slug,
    })
    .from(accounts)
    .leftJoin(brands, eq(brands.id, accounts.brandId))
    .where(eq(accounts.id, boundAccountId))
    .limit(1);
  if (!acct || acct.platform !== "tiktok") {
    return back("invalid_account", { brandSlug: acct?.brandSlug });
  }

  // Zernio's echoed param casing is unverified — accept a few aliases.
  const echoedAccountId =
    url.searchParams.get("accountId") ||
    url.searchParams.get("account_id") ||
    url.searchParams.get("connectedAccountId") ||
    null;
  const echoedUsername = url.searchParams.get("username");

  let zernioAccounts;
  try {
    zernioAccounts = await listAccounts({ platform: "tiktok" });
  } catch {
    return back("error", { brandSlug: acct.brandSlug });
  }

  const match = matchZernioAccount({
    handle: acct.handle,
    echoedAccountId,
    echoedUsername,
    accounts: zernioAccounts,
  });
  if (!match.ok) {
    return back(match.status, {
      brandSlug: acct.brandSlug,
      connectedAs: match.status === "wrong_account" ? match.connectedAs : null,
    });
  }

  await db
    .update(accounts)
    .set({ zernioAccountId: match.zernioAccountId, updatedAt: new Date() })
    .where(eq(accounts.id, boundAccountId));

  return back("connected", { brandSlug: acct.brandSlug });
}
