// Server-only client for the beehiiv v2 API (Futurepedia's newsletter):
// reads past editions/templates, and creates UNSENT DRAFT posts for the
// How-To push. It can never publish, schedule, update, delete or reach
// subscribers — see ALLOWED_CALLS and assertSafeDraftCreate.
//
// beehiiv API keys can't be scoped (the key Sam created covers every
// publication in the workspace, with full write access), so the guarantee
// that Hub & Spoke never publishes, schedules, deletes, reads subscribers or
// touches another publication lives HERE: anything not on ALLOWED_CALLS is
// refused before a request leaves the server.
//
// Env:
//   BEEHIIV_API_KEY   workspace key (Heroku config only; never in code/chat)

import { beehiivEditUrl } from "./beehiiv-links";
import { htmlToText } from "./html-text";
export { beehiivEditUrl, beehiivPreviewUrl } from "./beehiiv-links";

const BASE_URL = "https://api.beehiiv.com/v2";

/** The Kevin / Saj templates our drafts copy the look of (read-only references; we never post into them). */
export const HOWTO_POST_TEMPLATE_IDS = {
  kevin: "post_template_76011007-958d-4538-89dc-40bbe45f87a1",
  saj: "post_template_b3286956-4e4e-40a2-a465-090aacde5aec",
} as const;
/**
 * The only template a draft may be created from: "Hub & Spoke" — a copy of
 * the Saj template with its content removed (Sam, 2026-10-21), so the post
 * holds exactly the blocks we send but keeps the template's DESIGN: fonts,
 * colors and the footer (social icons, HubSpot Media cross-promo, privacy,
 * unsubscribe). beehiiv's API can't fill a template's placeholders, so the
 * Kevin/Saj cards are rebuilt as native blocks (beehiiv-draft.ts). Footer or
 * font edits to this template carry over to every draft.
 */
export const HOWTO_BASE_TEMPLATE_ID = "post_template_44db1934-36eb-41c5-a448-e08161e4edbb";
/** The guest authors shown on each edition. */
export const HOWTO_AUTHOR_IDS = {
  kevin: "guest_925e71d0-7b16-4fe1-80c0-5190b91d3ef1",
  saj: "guest_dcb6e333-05bb-4f6d-819b-9773d0d6be95",
} as const;
/** "How was Futurepedia today?" — the feedback poll both templates use. */
export const HOWTO_POLL_ID = "poll_2384fd00-6ac7-4f5e-be32-128d163b5cba";

/** The Futurepedia publication: both the Kevin (Futurepedia) and Saj (Skill Leap) How-To editions go out from it. */
export const FUTUREPEDIA_PUBLICATION_ID = "pub_535435b5-116b-4462-b22b-4fdd5f71a1b7";
/** "Skill Leap Members, All Statuses": excluded from every How-To edition. */
export const SKILL_LEAP_MEMBERS_SEGMENT_ID = "seg_a046fc91-f81d-46f7-8639-a7918a351fe7";

export class BeehiivError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function apiKey(): string {
  const k = process.env.BEEHIIV_API_KEY;
  if (!k) throw new BeehiivError(503, "BEEHIIV_API_KEY not set");
  return k;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PUB = FUTUREPEDIA_PUBLICATION_ID.replace(/-/g, "\\-");
/** Post / template HTML we may ask for (never subscriber data). `stats` is allowed on ONE post's read only (below), never on lists. */
const CONTENT_EXPANDS = ["free_web_content", "free_email_content"];
const PAGING = { limit: /^\d{1,3}$/, page: /^\d{1,4}$/ };

/**
 * The ONLY beehiiv calls this client may make, as path + the query params each
 * may carry (anything else in the query is refused too). Adding an entry here
 * is a scope change — get it reviewed. See docs/automation.md → beehiiv.
 */
const ALLOWED_CALLS: ReadonlyArray<{ method: string; path: RegExp; query: Record<string, RegExp | string[]>; why: string }> = [
  { method: "GET", path: /^\/publications$/, query: PAGING, why: "list the workspace's publications (names + ids) to confirm which is Futurepedia" },
  {
    method: "GET",
    path: new RegExp(`^/publications/${PUB}/posts$`),
    query: {
      ...PAGING,
      status: ["draft", "confirmed", "archived", "all"],
      order_by: ["created", "publish_date", "displayed_date"],
      direction: ["asc", "desc"],
      expand: [...CONTENT_EXPANDS, "recipients"],
      "expand[]": [...CONTENT_EXPANDS, "recipients"],
    },
    why: "read Futurepedia's past editions (dates, subjects, content, audience) so new ones don't repeat them",
  },
  {
    method: "GET",
    path: new RegExp(`^/publications/${PUB}/posts/post_${UUID}$`),
    query: { expand: [...CONTENT_EXPANDS, "recipients", "stats"], "expand[]": [...CONTENT_EXPANDS, "recipients", "stats"] },
    why: "read one Futurepedia edition (and, with stats, a sent edition's opens/clicks for its content page — aggregate counts only)",
  },
  { method: "GET", path: new RegExp(`^/publications/${PUB}/post_templates$`), query: PAGING, why: "list the Kevin / Saj post templates" },
  {
    method: "GET",
    path: new RegExp(`^/publications/${PUB}/post_templates/post_template_${UUID}$`),
    query: { expand: CONTENT_EXPANDS, "expand[]": CONTENT_EXPANDS },
    why: "read a post template's layout",
  },
  {
    method: "POST",
    path: new RegExp(`^/publications/${PUB}/posts$`),
    query: {},
    why: "create ONE unsent draft post (the request body is checked by assertSafeDraftCreate: status must be draft, no schedule)",
  },
  {
    method: "PATCH",
    path: new RegExp(`^/publications/${PUB}/posts/post_${UUID}$`),
    query: {},
    why: "replace the body (and title / subject) of ONE draft post Hub & Spoke created (assertSafeDraftUpdate: content only — never status, schedule, audience or authors; updateFuturepediaDraft checks the post is still a draft first)",
  },
  {
    method: "GET",
    path: new RegExp(`^/publications/${PUB}/segments/${SKILL_LEAP_MEMBERS_SEGMENT_ID.replace(/-/g, "\\-")}$`),
    query: {},
    why: "confirm the Skill Leap members segment exists (details only, never its members)",
  },
];

/** Throws unless (method, path + query) is on the allowlist. Exported for tests. */
export function assertAllowedBeehiivCall(method: string, pathWithQuery: string): void {
  const [path, qs = ""] = pathWithQuery.split("?", 2);
  const params = [...new URLSearchParams(qs).entries()];
  const ok = ALLOWED_CALLS.some(
    (c) =>
      c.method === method.toUpperCase() &&
      c.path.test(path) &&
      params.every(([k, v]) => {
        const rule = c.query[k];
        if (!rule) return false;
        return Array.isArray(rule) ? rule.includes(v) : rule.test(v);
      }),
  );
  if (!ok) throw new BeehiivError(403, `Blocked beehiiv call ${method} ${pathWithQuery}: not on the allowlist`);
}

async function beehiivFetch<T>(method: "GET" | "POST" | "PATCH", pathWithQuery: string, body?: unknown): Promise<T> {
  assertAllowedBeehiivCall(method, pathWithQuery);
  if (method === "POST") assertSafeDraftCreate(body);
  if (method === "PATCH") assertSafeDraftUpdate(body);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE_URL}${pathWithQuery}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    // Only reads are retried: a create that timed out may have succeeded, and a retry would make a second draft (an update is idempotent but is not retried either: it runs once per click).
    if (res.status === 429 && method === "GET" && attempt < 2) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BeehiivError(res.status, `beehiiv ${method} ${pathWithQuery} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }
}

const beehiivGet = <T,>(pathWithQuery: string) => beehiivFetch<T>("GET", pathWithQuery);

/** The fields a draft-create body may carry (anything else — scheduled_at, newsletter_list_id, headers… — is refused). */
const DRAFT_FIELDS = new Set([
  "title",
  "subtitle",
  "post_template_id",
  "blocks",
  "guest_author_ids",
  "status",
  "recipients",
  "email_settings",
  "web_settings",
  "thumbnail_image_url",
  "content_tags",
]);
const EMAIL_SETTINGS = new Set(["email_subject_line", "email_preview_text", "display_title_in_email", "display_subtitle_in_email"]);
const WEB_SETTINGS = new Set(["slug", "display_title_on_web", "display_subtitle_on_web"]);
/** Content blocks a draft may carry: the rendered email (html), the poll card, and the native blocks; no ads, embeds, RSS or paywalls, and no per-block audience targeting. */
const DRAFT_BLOCK_TYPES = new Set(["html", "section", "heading", "paragraph", "list", "image", "button", "poll"]);
/** What an html block may never carry: anything that runs or loads code, or a form. beehiiv strips <style>/<link> itself. */
const HTML_FORBIDDEN = /<\s*(script|iframe|object|embed|form|meta|base)\b|javascript:|\son[a-z]+\s*=/i;

/** Throws unless `html` is a plain rendered email fragment (no scripts, frames, forms or event handlers). Exported for tests. */
export function assertSafeHtmlBlock(html: unknown, no: (why: string) => never = (why) => { throw new BeehiivError(403, `Blocked beehiiv draft: ${why}`); }): void {
  if (typeof html !== "string" || !html.trim()) no("an html block needs its html");
  const m = (html as string).match(HTML_FORBIDDEN);
  if (m) no(`html block may not contain ${m[0].trim()}`);
}

function assertSafeBlocks(blocks: unknown, no: (why: string) => never, depth = 0): void {
  if (!Array.isArray(blocks) || blocks.length === 0) no("blocks must be a non-empty list");
  for (const b of blocks as unknown[]) {
    if (!b || typeof b !== "object") no("each block must be an object");
    const block = b as Record<string, unknown>;
    if (!DRAFT_BLOCK_TYPES.has(block.type as string)) no(`block type not allowed: ${String(block.type)}`);
    if ("visibility_settings" in block) no("blocks may not carry visibility_settings (audience targeting)");
    if (block.type === "html") assertSafeHtmlBlock(block.html, no);
    if (block.type === "poll" && block.poll_id !== HOWTO_POLL_ID) no("only the How-To feedback poll is allowed");
    if (block.type === "section") {
      if (depth > 0) no("sections can't be nested");
      assertSafeBlocks(block.blocks, no, depth + 1);
    }
  }
}

/**
 * Throws unless `body` can only make an UNSENT DRAFT: status is exactly
 * "draft" (beehiiv publishes immediately on "confirmed"), nothing schedules
 * it, it starts from Kevin's or Saj's template, and the email audience
 * excludes Skill Leap members and adds no segment. Exported for tests.
 */
export function assertSafeDraftCreate(body: unknown): void {
  const no = (why: string): never => {
    throw new BeehiivError(403, `Blocked beehiiv draft: ${why}`);
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return no("body must be an object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !DRAFT_FIELDS.has(k));
  if (extra.length) no(`fields not allowed: ${extra.join(", ")}`);
  if (b.status !== "draft") no(`status must be "draft" (got ${JSON.stringify(b.status)})`);
  if (b.post_template_id !== HOWTO_BASE_TEMPLATE_ID) no("post_template_id must be the empty How-To base template");
  assertSafeBlocks(b.blocks, no);
  const authors = b.guest_author_ids;
  if (authors !== undefined && (!Array.isArray(authors) || authors.length !== 1 || !Object.values(HOWTO_AUTHOR_IDS).includes(authors[0]))) {
    no("guest_author_ids must be exactly Kevin or Saj");
  }
  if (typeof b.title !== "string" || !b.title.trim()) no("title is required");
  const sub = (key: string, allowed: Set<string>) => {
    const v = b[key];
    if (v === undefined) return;
    if (!v || typeof v !== "object" || Array.isArray(v)) no(`${key} must be an object`);
    const bad = Object.keys(v as object).filter((k) => !allowed.has(k));
    if (bad.length) no(`${key} fields not allowed: ${bad.join(", ")}`);
  };
  sub("email_settings", EMAIL_SETTINGS);
  sub("web_settings", WEB_SETTINGS);
  const r = b.recipients as { email?: { tier_ids?: unknown; include_segment_ids?: unknown; exclude_segment_ids?: unknown }; web?: { tier_ids?: unknown } } | undefined;
  if (!r || typeof r !== "object") return no("recipients are required (the Skill Leap members segment must be excluded)");
  const okKeys = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
  if (!okKeys(r, ["email", "web"]) || !r.email || !okKeys(r.email, ["tier_ids", "include_segment_ids", "exclude_segment_ids"])) no("recipients has unexpected fields");
  if (!Array.isArray(r.email!.exclude_segment_ids) || !r.email!.exclude_segment_ids.includes(SKILL_LEAP_MEMBERS_SEGMENT_ID)) no("the Skill Leap members segment must be excluded");
  if (r.email!.include_segment_ids !== undefined && (!Array.isArray(r.email!.include_segment_ids) || r.email!.include_segment_ids.length > 0)) no("no segment may be added");
  if (r.web && !okKeys(r.web, ["tier_ids"])) no("recipients.web has unexpected fields");
}

/** The fields an update may carry: the content and the words around it. Nothing that sends, schedules, retargets or re-attributes the post. */
const UPDATE_FIELDS = new Set(["blocks", "content_merge_strategy", "title", "subtitle", "email_settings", "thumbnail_image_url"]);

/**
 * Throws unless `body` only replaces a draft's content / title / subject:
 * `blocks` (checked like a create's) with `content_merge_strategy` "replace"
 * (the default; anything else would leave the old copy in the post), and
 * nothing else beyond title, subtitle, email subject / preview and the
 * thumbnail. `status`, `scheduled_at`, `recipients`, authors, `body_content`
 * and every other field are refused. Exported for tests.
 */
export function assertSafeDraftUpdate(body: unknown): void {
  const no = (why: string): never => {
    throw new BeehiivError(403, `Blocked beehiiv update: ${why}`);
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return no("body must be an object");
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (!keys.length) no("nothing to update");
  const extra = keys.filter((k) => !UPDATE_FIELDS.has(k));
  if (extra.length) no(`fields not allowed: ${extra.join(", ")}`);
  if (b.blocks !== undefined) assertSafeBlocks(b.blocks, no);
  if (b.content_merge_strategy !== undefined && b.content_merge_strategy !== "replace") no('content_merge_strategy must be "replace"');
  if (b.content_merge_strategy !== undefined && b.blocks === undefined) no("content_merge_strategy needs blocks");
  if (b.title !== undefined && (typeof b.title !== "string" || !b.title.trim())) no("title can't be blank");
  const es = b.email_settings;
  if (es !== undefined) {
    if (!es || typeof es !== "object" || Array.isArray(es)) no("email_settings must be an object");
    const bad = Object.keys(es as object).filter((k) => !EMAIL_SETTINGS.has(k));
    if (bad.length) no(`email_settings fields not allowed: ${bad.join(", ")}`);
  }
}

function qs(params: Record<string, string | number | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) sp.append(`${k}[]`, x);
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface BeehiivPublication {
  id: string;
  name: string;
}

export interface BeehiivPost {
  id: string;
  title: string;
  subtitle?: string | null;
  slug?: string;
  status: string;
  publish_date?: number | null;
  displayed_date?: number | null;
  created?: number;
  web_url?: string;
  content_tags?: string[];
  content?: { free?: { web?: string; email?: string } };
  [k: string]: unknown;
}

export async function listPublications(): Promise<BeehiivPublication[]> {
  const r = await beehiivGet<{ data: BeehiivPublication[] }>(`/publications${qs({ limit: 100 })}`);
  return r.data;
}

/** One page of Futurepedia posts, newest by publish date first. */
export async function listFuturepediaPosts(opts: {
  page?: number;
  limit?: number;
  status?: "draft" | "confirmed" | "archived" | "all";
  expand?: ("free_web_content" | "free_email_content" | "recipients")[];
} = {}): Promise<{ data: BeehiivPost[]; page: number; total_pages: number; total_results: number }> {
  return beehiivGet(
    `/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts${qs({
      limit: opts.limit ?? 50,
      page: opts.page ?? 1,
      status: opts.status ?? "confirmed",
      order_by: "publish_date",
      direction: "desc",
      expand: opts.expand,
    })}`,
  );
}

export async function getFuturepediaPost(postId: string, expand: ("free_web_content" | "free_email_content" | "recipients" | "stats")[] = []): Promise<BeehiivPost> {
  const r = await beehiivGet<{ data: BeehiivPost }>(`/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts/${postId}${qs({ expand })}`);
  return r.data;
}

export interface BeehiivPostStats {
  /** Delivered: the open-rate denominator. */
  delivered: number;
  /** Unique opens (people, not repeat opens). */
  opens: number;
  /** Unique clicks. */
  clicks: number;
  unsubscribes: number;
}

/**
 * A sent edition's aggregate numbers (read-only; one post, counts only — never
 * who opened or clicked), or null while it has none (a draft or just sent).
 * Mirrors HubSpot's getHubspotEmailStats: unique opens → views, unique clicks.
 */
export async function getFuturepediaPostStats(postId: string): Promise<BeehiivPostStats | null> {
  const p = (await getFuturepediaPost(postId, ["stats"])) as BeehiivPost & { stats?: { email?: Record<string, number> } };
  const e = p.stats?.email;
  if (!e || !e.delivered) return null;
  return { delivered: e.delivered, opens: e.unique_opens ?? 0, clicks: e.unique_clicks ?? 0, unsubscribes: e.unsubscribes ?? 0 };
}

export async function listFuturepediaPostTemplates(): Promise<{ id: string; name: string; [k: string]: unknown }[]> {
  const r = await beehiivGet<{ data: { id: string; name: string }[] }>(`/publications/${FUTUREPEDIA_PUBLICATION_ID}/post_templates${qs({ limit: 100 })}`);
  return r.data;
}

export async function getFuturepediaPostTemplate(templateId: string, expand: ("free_web_content" | "free_email_content")[] = []): Promise<{ id: string; name: string; [k: string]: unknown }> {
  const r = await beehiivGet<{ data: { id: string; name: string } }>(`/publications/${FUTUREPEDIA_PUBLICATION_ID}/post_templates/${templateId}${qs({ expand })}`);
  return r.data;
}

export async function getSkillLeapMembersSegment(): Promise<{ id: string; name: string; [k: string]: unknown }> {
  const r = await beehiivGet<{ data: { id: string; name: string } }>(`/publications/${FUTUREPEDIA_PUBLICATION_ID}/segments/${SKILL_LEAP_MEMBERS_SEGMENT_ID}`);
  return r.data;
}


/**
 * Create ONE unsent draft post, then read it back and confirm beehiiv saved
 * it as a draft. Never retried (a retry after a create that went through
 * would leave a second draft; drafts can't be deleted from here).
 * `onCreated` runs as soon as beehiiv returns the id — before the read-back —
 * so the caller records the post even if the check below fails.
 * beehiiv's read right after a create can come back without a status yet, so
 * the read-back polls (~10s) until it has one; a status other than "draft" is
 * a loud error.
 */
export async function createFuturepediaDraft(
  body: Record<string, unknown>,
  onCreated?: (post: { id: string; editUrl: string }) => Promise<void>,
): Promise<{ id: string; editUrl: string }> {
  const created = await beehiivFetch<{ data: BeehiivPost }>("POST", `/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts`, body);
  const id = created.data?.id;
  if (!id || !/^post_/.test(id)) throw new BeehiivError(502, "beehiiv didn't return a post id");
  const post = { id, editUrl: beehiivEditUrl(id) };
  await onCreated?.(post);
  let status: string | undefined;
  for (let i = 0; i < 6 && !status; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    status = (await getFuturepediaPost(id)).status || undefined;
  }
  if (status !== "draft") {
    throw new BeehiivError(500, `beehiiv post ${id} reads back as "${status ?? "no status yet"}", not draft — check it in beehiiv (${post.editUrl})`);
  }
  return post;
}

/** The update was refused because beehiiv's copy no longer carries the words Hub & Spoke last sent (someone edited the post there). */
export class BeehiivHandEditedError extends BeehiivError {
  constructor(editUrl: string) {
    super(409, `beehiiv's copy was edited by hand since the last push — Update would replace those edits (${editUrl})`);
  }
}
/** The marker the editor looks for to offer "Replace anyway". */
export const HAND_EDITED_MARK = "edited by hand";

/**
 * Whether the post in beehiiv still carries the words Hub & Spoke last sent
 * (`pushedText`, htmlToText of the pushed fragment): beehiiv wraps the block
 * in its own header / footer and rewrites link URLs, so the check is "our
 * words are still in there", not "the HTML is identical". No rendered email
 * yet (a post still processing) can't be judged, so it passes. Pure; exported for tests.
 */
export function handEditedInBeehiiv(pushedText: string | null | undefined, currentEmailHtml: string | null | undefined): boolean {
  const expect = pushedText?.trim();
  if (!expect || !currentEmailHtml) return false;
  return !htmlToText(currentEmailHtml).includes(expect);
}

/**
 * Replace the content of ONE draft post Hub & Spoke created (the "Update in
 * beehiiv" button): refuses a post that is no longer a draft (sent or
 * scheduled there), and — unless `force` — one whose copy was edited by hand
 * in beehiiv since the last push (BeehiivHandEditedError, so the editor can
 * ask). Reads the post back afterwards and requires it to still be a draft.
 * Never changes status, schedule, audience or author (assertSafeDraftUpdate).
 */
export async function updateFuturepediaDraft(
  postId: string,
  body: Record<string, unknown>,
  opts: { pushedText?: string | null; force?: boolean } = {},
): Promise<{ id: string; editUrl: string }> {
  const editUrl = beehiivEditUrl(postId);
  const current = await getFuturepediaPost(postId, ["free_email_content"]);
  if (current.status !== "draft") throw new BeehiivError(409, `beehiiv post is "${current.status}", not a draft any more — it can't be updated from here (${editUrl})`);
  if (!opts.force && handEditedInBeehiiv(opts.pushedText, current.content?.free?.email)) throw new BeehiivHandEditedError(editUrl);
  await beehiivFetch<{ data: BeehiivPost }>("PATCH", `/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts/${postId}`, body);
  const after = await getFuturepediaPost(postId);
  if (after.status !== "draft") throw new BeehiivError(500, `beehiiv post ${postId} reads back as "${after.status}" after the update — check it in beehiiv (${editUrl})`);
  return { id: postId, editUrl };
}
