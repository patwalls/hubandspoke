// Rebrandly (clickhubspot.com) client for non–Starter Story ManyChat DM
// keywords. Each keyword is a Rebrandly link "<prefix>-<keyword>" in the
// "Hub & Spoke Content" workspace; ManyChat DMs that fixed short URL and
// Hub & Spoke repoints its destination at the post's offer when an editor
// attaches the keyword (src/lib/services/dm-keyword.ts).
//
// Auth: REBRANDLY_API_KEY (Heroku config). The workspace + domain ids are not
// secret, so they default here and can be overridden by env.
//
// API: https://developers.rebrandly.com — GET /v1/links (25 per page, cursor
// = `last` link id; `slashtag` filters to one exact link), POST /v1/links to
// create, POST /v1/links/{id} to update (destination + title + favourite are
// required on update).

const API_BASE = "https://api.rebrandly.com/v1";
const DEFAULT_WORKSPACE_ID = "145af512bf064e498d1a578f9ac2bcf7"; // "Hub & Spoke Content"
const DEFAULT_DOMAIN_ID = "8415698828d04a0b97b5ee83e3127011"; // clickhubspot.com
const PAGE_SIZE = 25;
// Keyword links + one per-post link per attached post share the domain.
const MAX_PAGES = 80;
const TIMEOUT_MS = 10_000;

export class RebrandlyApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RebrandlyApiError";
  }
}

export interface RebrandlyLink {
  id: string;
  slashtag: string;
  shortUrl: string;
  destination: string;
  title: string | null;
  favourite: boolean;
  clicks: number;
  lastClickAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function config() {
  const apiKey = process.env.REBRANDLY_API_KEY;
  if (!apiKey) throw new RebrandlyApiError(503, "Rebrandly isn't configured (REBRANDLY_API_KEY is not set)");
  return {
    apiKey,
    workspaceId: process.env.REBRANDLY_WORKSPACE_ID || DEFAULT_WORKSPACE_ID,
    domainId: process.env.REBRANDLY_DOMAIN_ID || DEFAULT_DOMAIN_ID,
  };
}

async function call<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const { apiKey, workspaceId } = config();
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        apikey: apiKey,
        workspace: workspaceId,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new RebrandlyApiError(502, `Rebrandly request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = (json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new RebrandlyApiError(res.status === 401 || res.status === 403 ? 502 : res.status, `Rebrandly: ${msg}`);
  }
  return json as T;
}

function toLink(raw: Record<string, unknown>): RebrandlyLink {
  return {
    id: String(raw.id),
    slashtag: String(raw.slashtag ?? ""),
    shortUrl: String(raw.shortUrl ?? ""),
    destination: String(raw.destination ?? ""),
    title: typeof raw.title === "string" ? raw.title : null,
    favourite: raw.favourite === true,
    clicks: typeof raw.clicks === "number" ? raw.clicks : 0,
    lastClickAt: typeof raw.lastClickAt === "string" ? raw.lastClickAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/** Every link on the clickhubspot.com domain in the workspace. */
export async function listWorkspaceLinks(fetchImpl: typeof fetch = fetch): Promise<RebrandlyLink[]> {
  const { domainId } = config();
  const out: RebrandlyLink[] = [];
  let last: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ "domain.id": domainId, limit: String(PAGE_SIZE), orderBy: "createdAt", orderDir: "desc" });
    if (last) params.set("last", last);
    const batch = await call<Record<string, unknown>[]>(`/links?${params}`, {}, fetchImpl);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch.map(toLink));
    if (batch.length < PAGE_SIZE) break;
    last = String(batch[batch.length - 1].id);
  }
  return out;
}

/** The link with this exact slashtag on clickhubspot.com, or null. */
export async function getLinkBySlashtag(slashtag: string, fetchImpl: typeof fetch = fetch): Promise<RebrandlyLink | null> {
  const { domainId } = config();
  const params = new URLSearchParams({ "domain.id": domainId, slashtag, limit: "1" });
  const batch = await call<Record<string, unknown>[]>(`/links?${params}`, {}, fetchImpl);
  const hit = Array.isArray(batch) ? batch.find((l) => String(l.slashtag ?? "").toLowerCase() === slashtag.toLowerCase()) : undefined;
  return hit ? toLink(hit) : null;
}

/** Create clickhubspot.com/<slashtag> → destination. */
export async function createLink(
  args: { slashtag: string; destination: string; title: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RebrandlyLink> {
  const { domainId } = config();
  const raw = await call<Record<string, unknown>>(
    "/links",
    { method: "POST", body: { slashtag: args.slashtag, destination: args.destination, title: args.title, domain: { id: domainId } } },
    fetchImpl,
  );
  return toLink(raw);
}

/** Point an existing link at a new destination. The short URL stays the same. */
export async function updateLinkDestination(
  link: Pick<RebrandlyLink, "id" | "title" | "favourite">,
  destination: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RebrandlyLink> {
  const raw = await call<Record<string, unknown>>(
    `/links/${encodeURIComponent(link.id)}`,
    {
      method: "POST",
      // Rebrandly requires title + favourite on update; send the link's own.
      body: { destination, title: link.title?.trim() || "Hub & Spoke DM keyword", favourite: link.favourite },
    },
    fetchImpl,
  );
  return toLink(raw);
}
