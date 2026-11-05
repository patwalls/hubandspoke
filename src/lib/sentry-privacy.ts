/**
 * Strips user data from every error and transaction event before it leaves
 * the process (server, edge, browser, and worker). Wired as `beforeSend` AND
 * `beforeSendTransaction` in every `Sentry.init` via `sentryPrivacyOptions`.
 *
 * WHY. Error tracking moved from sentry.io to a self-hosted GlitchTip
 * (https://glitchtip.walls.sh) on 2026-11-05 — sentry.io is not a
 * HubSpot-approved vendor. Pat's condition for the move: no user data in error
 * reports, ever. Before this, every event carried the signed-in user's
 * `{ id, email, username }` (setSentrySessionUser / <SentryUser>, now deleted)
 * and `sendDefaultPii: true` added IPs, cookies and request bodies. Scrubbing
 * at this one choke-point makes the guarantee structural: a capture site that
 * forgets cannot leak. Mirrors starter-story's lib/sentry_privacy.rb.
 *
 * KEPT: exception type + (redacted) message + stack frames, route (method +
 * path, no query), release, environment, tags/extra that do not name a person.
 * DROPPED: the `user` interface; request cookies, body, query string, env and
 * all headers but a short allowlist; any value under a PII-named key; email
 * addresses and IPv4 addresses inside ANY string (exception values, messages,
 * breadcrumbs, stack-frame vars, span descriptions = raw SQL / outbound
 * URLs); stack-frame source lines are dropped.
 */

export const FILTERED = "[filtered]";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

// Keys whose VALUES are user data: the whole key, or a `_`/`-`-delimited part.
const PII_KEY =
  /(?:^|[_.-])(?:e?mails?|email_?address|name|first_?name|last_?name|full_?name|user_?name|username|login|phone|phone_?number|mobile|address|street|zip|postal_?code|ip|ip_?address|remote_?ip|password|passwd|secret|token|api_?key|authorization|cookie|cookies|session|card|card_?number|cvc|ssn|dob|birthday)(?:$|[_.-])/i;

export const SAFE_HEADERS = new Set(
  ["host", "content-type", "content-length", "accept", "x-request-id", "x-request-start"],
);

// SDK-owned contexts describe the runtime, not a person (`runtime.name` is
// "node"); only their strings are redacted.
const SDK_CONTEXTS = new Set(["os", "runtime", "trace", "app", "device", "browser", "culture", "cloud_resource"]);

export function isPiiKey(key: string): boolean {
  // Split camelCase so `userEmail` / `ipAddress` match like `user_email`.
  const snake = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return PII_KEY.test(snake);
}

export function scrubString(s: string): string {
  return s.replace(EMAIL, "[email]").replace(IPV4, "[ip]");
}

export function scrubValue(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined && isPiiKey(key) && value !== null && value !== undefined) return FILTERED;
  if (depth > 12) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, undefined, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v, k, depth + 1);
    return out;
  }
  return value;
}

function scrubStringsOnly(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => scrubStringsOnly(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubStringsOnly(v, depth + 1);
    return out;
  }
  return value;
}

function stripQuery(url: string): string {
  return scrubString(url.split("?")[0].split("#")[0]);
}

// Loose structural type: works for ErrorEvent and TransactionEvent alike.
type AnyEvent = {
  user?: unknown;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  message?: string;
  transaction?: string;
  logentry?: { message?: string; formatted?: string; params?: unknown[] };
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
    env?: unknown;
    headers?: Record<string, string>;
    [k: string]: unknown;
  };
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown>; [k: string]: unknown }>;
  exception?: { values?: Array<{ value?: string; stacktrace?: unknown; [k: string]: unknown }> };
  threads?: { values?: Array<{ stacktrace?: unknown; [k: string]: unknown }> };
  spans?: Array<{ description?: string; data?: Record<string, unknown>; [k: string]: unknown }>;
};

// Stack frames carry source lines (the Node ContextLines integration) and, if
// local-variable capture is ever on, `vars` — both can hold literal data, and a
// free-text name in a source line cannot be redacted reliably. So source lines
// are DROPPED (filename + lineno + function still locate the code; the live
// 2026-11-05 check caught them echoing literals) and vars are scrubbed.
type Frame = { context_line?: string; pre_context?: string[]; post_context?: string[]; vars?: Record<string, unknown> };
function scrubFrames(stacktrace: unknown): void {
  const frames = (stacktrace as { frames?: Frame[] } | undefined)?.frames;
  if (!Array.isArray(frames)) return;
  for (const f of frames) {
    delete f.context_line;
    delete f.pre_context;
    delete f.post_context;
    if (f.vars) f.vars = scrubValue(f.vars) as Record<string, unknown>;
  }
}

export function scrubEvent<E>(event: E): E {
  if (!event || typeof event !== "object") return event;
  const e = event as unknown as AnyEvent;

  delete e.user;
  if (e.extra) e.extra = scrubValue(e.extra) as Record<string, unknown>;
  if (e.tags) e.tags = scrubValue(e.tags) as Record<string, unknown>;
  if (e.contexts) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.contexts)) {
      out[k] = SDK_CONTEXTS.has(k) ? scrubStringsOnly(v) : scrubValue(v);
    }
    e.contexts = out;
  }
  if (typeof e.message === "string") e.message = scrubString(e.message);
  if (typeof e.transaction === "string") e.transaction = scrubString(e.transaction);
  if (e.logentry) {
    if (typeof e.logentry.message === "string") e.logentry.message = scrubString(e.logentry.message);
    if (typeof e.logentry.formatted === "string") e.logentry.formatted = scrubString(e.logentry.formatted);
    if (e.logentry.params) e.logentry.params = scrubValue(e.logentry.params) as unknown[];
  }

  if (e.request) {
    const r = e.request;
    if (typeof r.url === "string") r.url = stripQuery(r.url);
    delete r.query_string;
    delete r.cookies;
    delete r.data;
    delete r.env;
    if (r.headers) {
      const kept: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers)) if (SAFE_HEADERS.has(k.toLowerCase())) kept[k] = v;
      r.headers = kept;
    }
  }

  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = e.breadcrumbs.map((b) => {
      const c = { ...b };
      if (typeof c.message === "string") c.message = scrubString(c.message);
      if (c.data) {
        const d = scrubValue(c.data) as Record<string, unknown>;
        if (typeof d.url === "string") d.url = stripQuery(d.url);
        c.data = d;
      }
      return c;
    });
  }

  for (const v of e.exception?.values ?? []) {
    if (typeof v.value === "string") v.value = scrubString(v.value);
    scrubFrames(v.stacktrace);
  }
  for (const t of e.threads?.values ?? []) scrubFrames(t.stacktrace);

  if (Array.isArray(e.spans)) {
    e.spans = e.spans.map((s) => {
      const c = { ...s };
      if (typeof c.description === "string") c.description = scrubString(c.description);
      if (c.data) c.data = scrubValue(c.data) as Record<string, unknown>;
      return c;
    });
  }
  return event;
}

/**
 * Spread into every Sentry.init: no default PII, no logs, and the scrubber on
 * both event kinds. `beforeSend` is composed with any extra filter a config
 * needs (none today).
 */
export const sentryPrivacyOptions = {
  sendDefaultPii: false,
  enableLogs: false,
  beforeSend: <E>(event: E): E => scrubEvent(event),
  beforeSendTransaction: <E>(event: E): E => scrubEvent(event),
  beforeBreadcrumb: <B>(crumb: B): B => {
    const c = crumb as unknown as { message?: string; data?: Record<string, unknown> };
    if (typeof c.message === "string") c.message = scrubString(c.message);
    if (c.data) c.data = scrubValue(c.data) as Record<string, unknown>;
    return crumb;
  },
} as const;
