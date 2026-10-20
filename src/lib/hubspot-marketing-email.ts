// Server-only client for HubSpot's Marketing Email v3 API in portal 53, used
// by the newsletter drafter to create an UNSENT draft email from a reviewed
// draft. It never publishes, schedules or sends — those stay manual in
// HubSpot.
//
// Approach: clone the format's template email (an existing, fully styled
// email in portal 53), then replace the template's body marker with the
// draft. The template's rich-text module must contain the literal text
// `[[NEWSLETTER_BODY]]`; that module's HTML is swapped for the draft body.
// Square brackets (not `{{ }}`) so HubL never interprets the marker.
//
// ASSUMED SHAPE — confirm against a real portal-53 email (read-only GET)
// before the first push: `POST /marketing/v3/emails/clone` with
// `{ id, cloneName }`, `PATCH /marketing/v3/emails/{id}` accepting `name`,
// `subject` and `content.widgets`, and rich-text widgets storing their HTML
// at `widgets[key].body.html`. If any of these differ, adjust here only.
//
// Env:
//   HUBSPOT_PORTAL_53_ACCESS_TOKEN   private-app / service-key token (marketing email scopes)
//   HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS  JSON map of format name → template email id,
//                                       e.g. {"Daily Seinfeld":"123","Sunday Breakfast":"456"}

const BASE_URL = "https://api.hubapi.com";
export const HUBSPOT_PORTAL_ID = "53";
export const BODY_MARKER = "[[NEWSLETTER_BODY]]";

export class HubspotEmailError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function token(): string {
  const t = process.env.HUBSPOT_PORTAL_53_ACCESS_TOKEN;
  if (!t) throw new HubspotEmailError(503, "HUBSPOT_PORTAL_53_ACCESS_TOKEN not set");
  return t;
}

/** Template email id for a format, from HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS. Case-insensitive. */
export function templateEmailIdFor(
  formatName: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.HUBSPOT_NEWSLETTER_TEMPLATE_EMAILS;
  if (!raw) return null;
  let map: Record<string, unknown>;
  try {
    map = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hit = Object.entries(map).find(([k]) => k.trim().toLowerCase() === formatName.trim().toLowerCase());
  return hit && (typeof hit[1] === "string" || typeof hit[1] === "number") ? String(hit[1]) : null;
}

export function emailEditUrl(emailId: string): string {
  return `https://app.hubspot.com/email/${HUBSPOT_PORTAL_ID}/edit/${emailId}/content`;
}

/**
 * The ONLY HubSpot calls this client may make. The portal-53 key's
 * `marketing-email` scope can also send/publish (HubSpot has no narrower
 * scope), so the guarantee that Hub & Spoke never sends, publishes, deletes,
 * or reaches contacts/CRM lives here: anything not listed is refused before a
 * request leaves the server. Adding an entry here is a scope change — get it
 * reviewed. See docs/automation.md → hubspot-newsletter-create-draft.
 */
const ALLOWED_CALLS: ReadonlyArray<{ method: string; path: RegExp; why: string }> = [
  { method: "GET", path: /^\/marketing\/v3\/emails\/\d+$/, why: "read an email (the template, or the clone we just made)" },
  { method: "POST", path: /^\/marketing\/v3\/emails\/clone$/, why: "copy the template into a new unsent email" },
  { method: "PATCH", path: /^\/marketing\/v3\/emails\/\d+$/, why: "fill in the clone's name, subject and body" },
];

/** Throws unless (method, path) is on the allowlist. Exported for tests. */
export function assertAllowedHubspotCall(method: string, path: string): void {
  const ok = ALLOWED_CALLS.some((c) => c.method === method.toUpperCase() && c.path.test(path));
  if (!ok) throw new HubspotEmailError(403, `Blocked HubSpot call ${method} ${path}: not on the allowlist`);
}

async function hubspotFetch<T>(path: string, init: { method: "GET" | "POST" | "PATCH"; body?: unknown }): Promise<T> {
  assertAllowedHubspotCall(init.method, path);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HubspotEmailError(res.status, `HubSpot ${init.method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }
}

interface Widget {
  body?: { html?: string; [k: string]: unknown };
  [k: string]: unknown;
}
export interface HubspotEmail {
  id: string;
  name?: string;
  subject?: string;
  content?: { widgets?: Record<string, Widget>; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * The `content.widgets` patch that swaps the marker module's HTML for the
 * draft body. Pure — exported for tests. Throws when the template has no
 * module containing BODY_MARKER, so a misconfigured template fails loudly
 * instead of producing an email with the template's placeholder copy.
 */
export function buildBodyWidgetPatch(email: HubspotEmail, bodyHtml: string): Record<string, Widget> {
  const widgets = email.content?.widgets ?? {};
  const key = Object.keys(widgets).find((k) => widgets[k]?.body?.html?.includes(BODY_MARKER));
  if (!key) {
    throw new HubspotEmailError(422, `template email ${email.id} has no rich-text module containing ${BODY_MARKER}`);
  }
  const widget = widgets[key];
  return { [key]: { ...widget, body: { ...widget.body, html: bodyHtml } } };
}

export async function createDraftEmailFromTemplate(args: {
  templateEmailId: string;
  name: string;
  subject: string;
  bodyHtml: string;
}): Promise<{ id: string; editUrl: string }> {
  const clone = await hubspotFetch<HubspotEmail>("/marketing/v3/emails/clone", {
    method: "POST",
    body: { id: args.templateEmailId, cloneName: args.name },
  });
  // Re-read rather than trusting the clone response to carry full content.
  const full = await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, { method: "GET" });
  const widgets = buildBodyWidgetPatch(full, args.bodyHtml);
  // Belt and braces: only ever edit the email this call just created, never the template.
  if (String(clone.id) === String(args.templateEmailId)) {
    throw new HubspotEmailError(500, "clone returned the template's own id; refusing to edit the template");
  }
  await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, {
    method: "PATCH",
    body: { name: args.name, subject: args.subject, content: { widgets } },
  });
  return { id: String(clone.id), editUrl: emailEditUrl(String(clone.id)) };
}
