// Server-only client for HubSpot's Marketing Email v3 API in portal 53, used
// by the newsletter drafter to create an UNSENT draft email from a reviewed
// draft. It never publishes, schedules or sends — those stay manual in
// HubSpot.
//
// Approach: copy the format's TEMPLATE EMAIL (a fully styled, never-sent
// email in the account, e.g. "[TEMPLATE] Sunday Breakfast – Hub & Spoke (do
// not send)"), then fill the rich-text blocks the format's newsletter template
// maps its sections to (`template.hubspot.blocks`), plus the subject and the
// preview text. Everything else in the copy — masthead, course labels,
// dividers, footer — stays exactly as the template email has it. Confirmed
// against account 20627419 on 2026-10-21: clone returns a DRAFT with the same
// widget ids; PATCH accepts name / subject / content.widgets.
//
// Env:
//   HUBSPOT_PORTAL_53_ACCESS_TOKEN   service key with ONLY the `content` scope
//                                    (account 20627419 despite the name)

const BASE_URL = "https://api.hubapi.com";
export const HUBSPOT_PORTAL_ID = "20627419";

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
  body?: { html?: string; path?: string; value?: string; label_text?: string; [k: string]: unknown };
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
 * The full `content.widgets` for the copy: every widget unchanged except the
 * filled rich-text blocks and the preview text. Sends ALL widgets so a PATCH
 * can never drop one. Throws when a mapped block is missing or isn't a
 * rich-text block, so a stale mapping fails loudly instead of producing a
 * half-filled email. Pure — exported for tests.
 */
/** Strip tags + decode the few entities markdownToEmailHtml emits (for label modules). */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildWidgets(
  email: HubspotEmail,
  blockHtml: Record<string, string>,
  previewText: string | null,
): Record<string, Widget> {
  const widgets: Record<string, Widget> = { ...(email.content?.widgets ?? {}) };
  for (const [id, html] of Object.entries(blockHtml)) {
    const w = widgets[id];
    if (!w) throw new HubspotEmailError(422, `template email ${email.id} has no block ${id} — update the format's HubSpot mapping`);
    if (w.body?.path === "@hubspot/rich_text") {
      widgets[id] = { ...w, body: { ...w.body, html } };
    } else if (typeof w.body?.label_text === "string") {
      // A label module (Daily Seinfeld's "Read Time"): plain text only.
      widgets[id] = { ...w, body: { ...w.body, label_text: htmlToText(html) } };
    } else {
      throw new HubspotEmailError(422, `block ${id} in template email ${email.id} isn't a rich-text block or a label`);
    }
  }
  if (previewText !== null && widgets.preview_text) {
    widgets.preview_text = { ...widgets.preview_text, body: { ...widgets.preview_text.body, value: previewText } };
  }
  return widgets;
}

export async function createDraftEmailFromTemplate(args: {
  templateEmailId: string;
  name: string;
  subject: string;
  previewText: string | null;
  /** HubSpot widget id → HTML for that rich-text block. */
  blockHtml: Record<string, string>;
}): Promise<{ id: string; editUrl: string }> {
  const clone = await hubspotFetch<HubspotEmail>("/marketing/v3/emails/clone", {
    method: "POST",
    body: { id: args.templateEmailId, cloneName: args.name },
  });
  // Belt and braces: only ever edit the email this call just created, never the template.
  if (String(clone.id) === String(args.templateEmailId)) {
    throw new HubspotEmailError(500, "clone returned the template's own id; refusing to edit the template");
  }
  const full = await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, { method: "GET" });
  const widgets = buildWidgets(full, args.blockHtml, args.previewText);
  await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, {
    method: "PATCH",
    body: { name: args.name, subject: args.subject, content: { widgets } },
  });
  return { id: String(clone.id), editUrl: emailEditUrl(String(clone.id)) };
}
