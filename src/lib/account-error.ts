/**
 * Turns the raw `lastRefreshError` / `lastContentSyncError` strings on an
 * account into a short label + one-line hint for the Accounts table. The raw
 * strings are written by our own services (account-refresh.ts,
 * account-content-sync.ts) and usually embed a provider's JSON body, so the
 * matching here is on those structural shapes, not on user content.
 *
 * Tones:
 *   error   — something is actually failing; red
 *   warning — the sync succeeded but skipped something; amber, date still shown
 *   muted   — expected/unsupported, nothing to fix; grey
 */
export type AccountErrorTone = "error" | "warning" | "muted";

export interface AccountErrorView {
  label: string;
  hint: string;
  tone: AccountErrorTone;
}

/** Pulls the provider's own `"message":"…"` out of an embedded JSON body. */
function providerMessage(raw: string): string | null {
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** HTTP status from our "<endpoint> 404: {…}" or refresh's "404 <msg>" shapes. */
function httpStatus(raw: string): number | null {
  const m = raw.match(/ (\d{3}):/) ?? raw.match(/^(\d{3}) /);
  return m ? Number(m[1]) : null;
}

export function describeAccountError(raw: string): AccountErrorView {
  if (raw.includes("personal profiles don't support content sync")) {
    return {
      label: "Not supported",
      hint: "LinkedIn doesn't share posts from personal profiles",
      tone: "muted",
    };
  }

  if (
    raw.includes("has no SC content-list support") ||
    raw.includes("has no account-level endpoint") ||
    raw.startsWith("Unknown platform")
  ) {
    return {
      label: "Not supported",
      hint: "Automatic sync isn't available for this platform",
      tone: "muted",
    };
  }

  const dupes = raw.match(/^(\d+) cross-account duplicates? skipped/);
  if (dupes) {
    const n = Number(dupes[1]);
    return {
      label: `${n} skipped`,
      hint: `${n} post${n === 1 ? " is" : "s are"} already tracked on another account`,
      tone: "warning",
    };
  }

  if (raw.includes('"account_deactivated":true') || raw.includes("Account deactivated")) {
    return {
      label: "Deactivated",
      hint: "The platform says this account was deactivated",
      tone: "error",
    };
  }

  if (
    raw.includes('"accountDoesNotExist":true') ||
    raw.includes("user is not found, or is private")
  ) {
    return {
      label: "Not found",
      hint: "Handle not found or the account is private — check the handle",
      tone: "error",
    };
  }

  if (raw.includes("returned no data")) {
    return {
      label: "No data",
      hint: "Lookup came back empty — check the handle",
      tone: "error",
    };
  }

  const status = httpStatus(raw);
  if (status === 401 || status === 403) {
    return {
      label: "Auth failed",
      hint: "Credentials were rejected — reconnect or update the API key",
      tone: "error",
    };
  }
  if (status === 404) {
    return {
      label: "Not found",
      hint: providerMessage(raw) ?? "The platform couldn't find this account",
      tone: "error",
    };
  }
  if (status === 429) {
    return {
      label: "Rate limited",
      hint: "Too many requests — it will retry on the next sync",
      tone: "error",
    };
  }
  if (status != null && status >= 500) {
    return {
      label: "Service error",
      hint: "The data provider had an error — usually temporary",
      tone: "error",
    };
  }

  const msg = providerMessage(raw) ?? raw;
  return {
    label: "Failed",
    hint: msg.length > 80 ? `${msg.slice(0, 77)}…` : msg,
    tone: "error",
  };
}
