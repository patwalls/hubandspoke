import type { ZernioAccount } from "@/lib/zernio";

// Which Zernio ConnectedAccount does a finished OAuth round-trip belong to?
//
// The handle is the source of truth. The TikTok login the user picks inside
// TikTok's OAuth screen is whatever their browser is signed into — which may
// not be the account they clicked "Connect" on. Two failures this guards:
//  - 2026-06: "Connect" on Starter Story while the browser was signed into
//    The Hustle bound Starter Story to The Hustle's TikTok (drafts would have
//    gone to the wrong account).
//  - 2026-11: with two TikTok accounts on the Zernio profile, the callback had
//    no echoed id and refused to guess, so Skill Leap's connect silently
//    went nowhere.
// So: list the profile's TikTok accounts and take the one whose username is
// this account's handle. An echoed id is only a tie-breaker, never trusted
// over the handle.

export type ConnectStatus =
  | "connected"
  | "wrong_account"
  | "no_account"
  | "invalid_state"
  | "invalid_account"
  | "error";

export type ConnectMatch =
  | { ok: true; zernioAccountId: string }
  | { ok: false; status: "wrong_account"; connectedAs: string | null }
  | { ok: false; status: "no_account" };

export function normalizeHandle(h: string | null | undefined): string {
  return (h ?? "").trim().replace(/^@/, "").toLowerCase();
}

export function matchZernioAccount(args: {
  handle: string;
  echoedAccountId: string | null;
  echoedUsername: string | null;
  accounts: ZernioAccount[];
}): ConnectMatch {
  const want = normalizeHandle(args.handle);
  const byHandle = args.accounts.filter(
    (a) => normalizeHandle(a.username) === want,
  );
  if (byHandle.length > 0) {
    const echoed = byHandle.find((a) => a._id === args.echoedAccountId);
    return { ok: true, zernioAccountId: (echoed ?? byHandle[0])._id };
  }
  // Nothing on the profile matches this handle. If Zernio told us who the
  // user actually signed in as, say so — that's the wrong-login case.
  const echoed = args.accounts.find((a) => a._id === args.echoedAccountId);
  const connectedAs = echoed?.username ?? args.echoedUsername ?? null;
  if (connectedAs) return { ok: false, status: "wrong_account", connectedAs };
  return { ok: false, status: "no_account" };
}

/** The banner the Accounts page shows after the round-trip. */
export function connectNotice(
  status: string | null | undefined,
  handle?: string | null,
  connectedAs?: string | null,
): { tone: "success" | "error"; text: string } | null {
  const h = handle ? `@${normalizeHandle(handle)}` : "this account";
  switch (status) {
    case "connected":
      return { tone: "success", text: `TikTok connected: ${h} can now receive drafts.` };
    case "wrong_account":
      return {
        tone: "error",
        text: `TikTok signed in as ${connectedAs ? `@${normalizeHandle(connectedAs)}` : "a different account"}, not ${h}. Sign TikTok into ${h} in this browser, then click Connect TikTok again.`,
      };
    case "no_account":
      return { tone: "error", text: `TikTok didn't finish connecting ${h}. Try Connect TikTok again.` };
    case "invalid_state":
      return { tone: "error", text: "The TikTok connect link expired. Click Connect TikTok again." };
    case "invalid_account":
      return { tone: "error", text: "That account isn't a TikTok account any more." };
    case "error":
      return { tone: "error", text: "Couldn't reach Zernio to finish connecting TikTok. Try again in a minute." };
    default:
      return null;
  }
}
