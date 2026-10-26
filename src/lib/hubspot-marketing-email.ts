// Server-only client for HubSpot's Marketing Email v3 API in portal 53, used
// by the newsletter drafter to create an UNSENT draft email from a reviewed
// draft. It never publishes, schedules or sends — those stay manual in
// HubSpot.
//
// Approach: copy the format's TEMPLATE EMAIL (a never-sent email in the
// account, e.g. "[TEMPLATE] Sunday Breakfast – Hub & Spoke (do not send)" —
// it carries the sender, the lists, the subscription type and the footer),
// then replace the copy's drag-and-drop layout with ONE rich-text block
// holding the whole email as Hub & Spoke renders it (renderEmailBody:
// masthead, headings, sections, images, buttons — table-based, inline CSS)
// followed by the template's footer block, plus the subject and the preview
// text. So the email is designed in Hub & Spoke end to end; HubSpot adds the
// footer (unsubscribe, address) and sends. Confirmed against account 20627419
// on 2026-10-21/23: clone returns a DRAFT with the same widget ids; PATCH
// accepts name / subject / content.widgets / content.flexAreas (a GET right
// after the PATCH reads `flexAreas` back as `{main: {}}`, but a clone of that
// email shows the two-section layout stored as sent; the rich text's HTML
// comes back byte-identical).
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
  {
    method: "GET",
    path: /^\/marketing\/v3\/emails\?limit=\d{1,3}&createdAfter=[0-9A-Za-z:.%-]+(&after=[A-Za-z0-9%=_-]+)?$/,
    why: "read past issues (read-only) to learn which stories they ran",
  },
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
  body?: { html?: string; path?: string; value?: string; label_text?: string; hs_enable_module_padding?: boolean; hs_wrapper_css?: Record<string, string>; [k: string]: unknown };
  [k: string]: unknown;
}
/** A drag-and-drop email's layout: sections of columns of widget ids. */
interface FlexColumn {
  id: string;
  widgets: string[];
  width: number;
  [k: string]: unknown;
}
interface FlexSection {
  id: string;
  columns: FlexColumn[];
  [k: string]: unknown;
}
interface FlexAreas {
  main?: { sections?: FlexSection[]; [k: string]: unknown };
  [k: string]: unknown;
}
export interface HubspotEmail {
  id: string;
  name?: string;
  subject?: string;
  content?: { widgets?: Record<string, Widget>; flexAreas?: FlexAreas; [k: string]: unknown };
  [k: string]: unknown;
}

const FOOTER = "@hubspot/email_footer";
const DIVIDER = "@hubspot/email_divider";
const RICH_TEXT = "@hubspot/rich_text";

/**
 * The copy's new `content`: its layout cut down to two sections — the first
 * rich-text block, now holding `html` (the whole email as Hub & Spoke renders
 * it, with no padding of HubSpot's around it), and the template's footer
 * (with any divider that sits with it) — plus the preview text. Every other
 * widget (the template's masthead, labels, old rich text) is dropped with its
 * section, so nothing of the template email shows twice. Throws when the
 * template has no rich-text block or no footer (HubSpot needs the footer's
 * unsubscribe link), so a stale template fails loudly. Pure — exported for
 * tests.
 */
export function buildHtmlEmailContent(
  email: HubspotEmail,
  html: string,
  previewText: string | null,
): { flexAreas: FlexAreas; widgets: Record<string, Widget> } {
  const widgets = email.content?.widgets ?? {};
  const main = email.content?.flexAreas?.main;
  const sections = main?.sections ?? [];
  const path = (id: string) => widgets[id]?.body?.path;
  const sectionOf = (id: string) => sections.find((s) => s.columns.some((c) => c.widgets.includes(id)));
  // The first rich-text block in layout order (else any), and the footer.
  const inLayout = sections.flatMap((s) => s.columns.flatMap((c) => c.widgets));
  const richId = inLayout.find((id) => path(id) === RICH_TEXT) ?? Object.keys(widgets).find((id) => path(id) === RICH_TEXT);
  const footerId = inLayout.find((id) => path(id) === FOOTER) ?? Object.keys(widgets).find((id) => path(id) === FOOTER);
  if (!richId) throw new HubspotEmailError(422, `template email ${email.id} has no rich-text block to hold the email`);
  if (!footerId) throw new HubspotEmailError(422, `template email ${email.id} has no footer block (HubSpot needs its unsubscribe link)`);
  const bodySec = sectionOf(richId);
  const footSec = sectionOf(footerId);
  if (!bodySec || !footSec) throw new HubspotEmailError(422, `template email ${email.id} has no drag-and-drop layout to fill`);
  const footerColumn = footSec.columns.find((c) => c.widgets.includes(footerId))!;
  const footerWidgets = footerColumn.widgets.filter((id) => id === footerId || path(id) === DIVIDER);
  const out: Record<string, Widget> = {
    [richId]: {
      ...widgets[richId],
      body: {
        ...widgets[richId].body,
        html,
        // The email carries its own padding; HubSpot's module padding would double it.
        hs_enable_module_padding: false,
        hs_wrapper_css: { "padding-top": "0px", "padding-right": "0px", "padding-bottom": "0px", "padding-left": "0px" },
      },
    },
  };
  for (const id of footerWidgets) out[id] = widgets[id];
  if (widgets.preview_text) out.preview_text = { ...widgets.preview_text, body: { ...widgets.preview_text.body, value: previewText ?? "" } };
  const flexAreas: FlexAreas = {
    ...email.content?.flexAreas,
    main: {
      ...main,
      sections: [
        { ...bodySec, columns: [{ ...bodySec.columns.find((c) => c.widgets.includes(richId))!, widgets: [richId], width: 12 }] },
        { ...footSec, columns: [{ ...footerColumn, widgets: footerWidgets, width: 12 }] },
      ],
    },
  };
  return { flexAreas, widgets: out };
}

export async function createDraftEmailFromTemplate(args: {
  templateEmailId: string;
  name: string;
  subject: string;
  previewText: string | null;
  /** The whole email body (renderEmailBody): fills the copy's one rich-text block. */
  html: string;
}): Promise<{ id: string; editUrl: string }> {
  const clone = await hubspotFetch<HubspotEmail>("/marketing/v3/emails/clone", {
    method: "POST",
    body: { id: args.templateEmailId, cloneName: args.name },
  });
  // Belt and braces: only ever edit the email this call just created, never the template.
  if (String(clone.id) === String(args.templateEmailId)) {
    throw new HubspotEmailError(500, "clone returned the template's own id; refusing to edit the template");
  }
  const editUrl = emailEditUrl(String(clone.id));
  try {
    const full = await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, { method: "GET" });
    const content = buildHtmlEmailContent(full, args.html, args.previewText);
    await hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${clone.id}`, {
      method: "PATCH",
      body: { name: args.name, subject: args.subject, content },
    });
  } catch (err) {
    // The copy exists but isn't filled: say where, so it's deleted rather than joined by a second one on retry.
    const status = err instanceof HubspotEmailError ? err.status : 500;
    throw new HubspotEmailError(status, `${(err as Error).message} — a half-filled copy was left in HubSpot (${editUrl}); delete it before trying again.`);
  }
  return { id: String(clone.id), editUrl };
}

/** One email, for its send state (`state`, `publishDate`). The same GET the push already uses. */
export async function getHubspotEmail(emailId: string): Promise<HubspotEmail> {
  return hubspotFetch<HubspotEmail>(`/marketing/v3/emails/${emailId}`, { method: "GET" });
}

export interface HubspotEmailSummary extends HubspotEmail {
  name?: string;
  subject?: string;
  state?: string;
  businessUnitId?: string | number | null;
  publishDate?: string | null;
  publishedAt?: string | null;
}

/** Every email created after `createdAfterIso`, page by page (read-only). */
export async function* listEmailsCreatedAfter(createdAfterIso: string): AsyncGenerator<HubspotEmailSummary> {
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs: string = `limit=100&createdAfter=${encodeURIComponent(createdAfterIso)}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    type Page = { results: HubspotEmailSummary[]; paging?: { next?: { after?: string } } };
    const res: Page = await hubspotFetch<Page>(`/marketing/v3/emails?${qs}`, { method: "GET" });
    for (const e of res.results) yield e;
    after = res.paging?.next?.after ?? null;
    if (!after) return;
  }
}

/** All rich-text HTML in an email, concatenated (for link extraction). Pure. */
export function emailRichTextHtml(email: HubspotEmail): string {
  return Object.values(email.content?.widgets ?? {})
    .map((w) => (typeof w.body?.html === "string" ? w.body.html : ""))
    .join("\n");
}
