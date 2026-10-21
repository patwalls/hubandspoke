// Server-only client for the beehiiv v2 API (Futurepedia's newsletter). READ
// ONLY for now: we're learning how the Futurepedia How-To runs (send days,
// which tools/tasks past editions covered, the Kevin/Saj templates) before
// building a "Create beehiiv draft" push. Creating/updating drafts will be a
// separate, reviewed allowlist change.
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

async function beehiivGet<T>(pathWithQuery: string): Promise<T> {
  assertAllowedBeehiivCall("GET", pathWithQuery);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE_URL}${pathWithQuery}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Number(res.headers.get("retry-after")) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BeehiivError(res.status, `beehiiv GET ${pathWithQuery} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
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
