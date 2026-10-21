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

const BASE_URL = "https://api.beehiiv.com/v2";

/** The only post templates a draft may start from: Kevin's (Futurepedia channel) and Saj's (Skill Leap channel). */
export const HOWTO_POST_TEMPLATE_IDS = {
  kevin: "post_template_76011007-958d-4538-89dc-40bbe45f87a1",
  saj: "post_template_b3286956-4e4e-40a2-a465-090aacde5aec",
} as const;

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
/** Post / template HTML we may ask for (never `stats` on lists, never subscriber data). */
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
    query: { expand: [...CONTENT_EXPANDS, "recipients"], "expand[]": [...CONTENT_EXPANDS, "recipients"] },
    why: "read one Futurepedia edition",
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

async function beehiivFetch<T>(method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<T> {
  assertAllowedBeehiivCall(method, pathWithQuery);
  if (method === "POST") assertSafeDraftCreate(body);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE_URL}${pathWithQuery}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    // Only reads are retried: a create that timed out may have succeeded, and a retry would make a second draft.
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
  "body_content",
  "status",
  "recipients",
  "email_settings",
  "web_settings",
  "thumbnail_image_url",
  "content_tags",
]);
const EMAIL_SETTINGS = new Set(["email_subject_line", "email_preview_text", "display_title_in_email", "display_subtitle_in_email"]);
const WEB_SETTINGS = new Set(["slug", "display_title_on_web", "display_subtitle_on_web"]);

/**
 * Throws unless `body` can only make an UNSENT DRAFT: status is exactly
 * "draft" (beehiiv publishes immediately on "confirmed"), nothing schedules
 * it, it starts from Kevin's or Saj's template, and the email audience
 * excludes Skill Leap members and adds no segment. Exported for tests.
 */
export function assertSafeDraftCreate(body: unknown): void {
  const no = (why: string) => {
    throw new BeehiivError(403, `Blocked beehiiv draft: ${why}`);
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return no("body must be an object");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !DRAFT_FIELDS.has(k));
  if (extra.length) no(`fields not allowed: ${extra.join(", ")}`);
  if (b.status !== "draft") no(`status must be "draft" (got ${JSON.stringify(b.status)})`);
  if (!Object.values(HOWTO_POST_TEMPLATE_IDS).includes(b.post_template_id as never)) no("post_template_id must be the Kevin or Saj template");
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

export async function getFuturepediaPost(postId: string, expand: ("free_web_content" | "free_email_content" | "recipients")[] = []): Promise<BeehiivPost> {
  const r = await beehiivGet<{ data: BeehiivPost }>(`/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts/${postId}${qs({ expand })}`);
  return r.data;
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

/** beehiiv's editor link for a post id ("post_<uuid>" → /posts/<uuid>/edit). */
export function beehiivEditUrl(postId: string): string {
  return `https://app.beehiiv.com/posts/${postId.replace(/^post_/, "")}/edit`;
}

/**
 * Create ONE unsent draft post, then read it back and confirm beehiiv saved
 * it as a draft with no publish date. Never retried (a retry after a create
 * that went through would leave a second draft; drafts can't be deleted from
 * here). Throws loudly if the read-back isn't a draft.
 */
export async function createFuturepediaDraft(body: Record<string, unknown>): Promise<{ id: string; editUrl: string }> {
  const created = await beehiivFetch<{ data: BeehiivPost }>("POST", `/publications/${FUTUREPEDIA_PUBLICATION_ID}/posts`, body);
  const id = created.data?.id;
  if (!id || !/^post_/.test(id)) throw new BeehiivError(502, "beehiiv didn't return a post id");
  const check = await getFuturepediaPost(id);
  if (check.status !== "draft") {
    throw new BeehiivError(500, `beehiiv saved post ${id} as "${check.status}", not draft — check it in beehiiv NOW (${beehiivEditUrl(id)})`);
  }
  return { id, editUrl: beehiivEditUrl(id) };
}
