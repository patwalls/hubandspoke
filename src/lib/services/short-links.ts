// Server-only client for the StarterStory Rails app's short-link REST API.
// Callers: the `/settings/links` RSC and the proxy API route under
// `/api/short-links/...`. Never import from a client component — that would
// leak SHORT_LINKS_API_KEY into the browser bundle.
//
// The redirect + click tracking itself lives in the Rails app (the `ShortLink`
// and `ShortLinkClick` models); hubandspoke is only the control plane.

// Possible CTA targets a tracking link can point at. "lead_magnet" → one of
// our opt-in offers; "episode" → a specific guest's published episode;
// "custom" → an explicit URL from the format Skill.
export type ShortLinkTargetType = "lead_magnet" | "episode" | "custom";

export interface ShortLink {
  slug: string;
  destinationUrl: string;
  clicksCount: number;
  leadsCount: number;
  // The subset of leadsCount captured via the HubSpot lead form (the rest are
  // native Starter Story captures: signups, pricing/checkout intent, opt-ins).
  // leadsCount === hubspotLeadsCount + native, so the UI can split LEADS.
  hubspotLeadsCount: number;
  lastClickedAt: string | null;
  tag: string | null;
  archived: boolean;
  // Content-association fields (StarterStory side: short_links table). Populated
  // when hubandspoke mints a per-post CTA link so clicks trace back to the post
  // and its target. Null for links created the old way (admin UI, Dub seed).
  contentSource: string | null;
  contentExternalId: string | null;
  leadMagnetId: number | null;
  targetType: ShortLinkTargetType | null;
  channel: string | null;
  utmCampaign: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ShortLinksApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RawShortLink = {
  slug: string;
  destination_url: string;
  clicks_count: number;
  leads_count?: number;
  hubspot_leads_count?: number;
  last_clicked_at: string | null;
  tag: string | null;
  archived: boolean;
  content_source: string | null;
  content_external_id: string | null;
  lead_magnet_id: number | null;
  target_type: ShortLinkTargetType | null;
  channel: string | null;
  utm_campaign: string | null;
  created_at: string;
  updated_at: string;
};

function normalize(raw: RawShortLink): ShortLink {
  return {
    slug: raw.slug,
    destinationUrl: raw.destination_url,
    clicksCount: raw.clicks_count,
    leadsCount: raw.leads_count ?? 0,
    hubspotLeadsCount: raw.hubspot_leads_count ?? 0,
    lastClickedAt: raw.last_clicked_at,
    tag: raw.tag,
    archived: raw.archived,
    contentSource: raw.content_source ?? null,
    contentExternalId: raw.content_external_id ?? null,
    leadMagnetId: raw.lead_magnet_id ?? null,
    targetType: raw.target_type ?? null,
    channel: raw.channel ?? null,
    utmCampaign: raw.utm_campaign ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// The content-association attributes hubandspoke sets when minting a per-post
// CTA link. Shared by create + update so the two stay in sync.
export interface ShortLinkContentAssociation {
  contentSource?: string;
  contentExternalId?: string;
  leadMagnetId?: number | null;
  targetType?: ShortLinkTargetType;
  channel?: string;
  utmCampaign?: string | null;
}

// Maps the camelCase association fields to the Rails-side snake_case params,
// omitting anything undefined so we never clobber existing values on update.
function associationParams(
  a: ShortLinkContentAssociation,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.contentSource !== undefined) out.content_source = a.contentSource;
  if (a.contentExternalId !== undefined)
    out.content_external_id = a.contentExternalId;
  if (a.leadMagnetId !== undefined) out.lead_magnet_id = a.leadMagnetId;
  if (a.targetType !== undefined) out.target_type = a.targetType;
  if (a.channel !== undefined) out.channel = a.channel;
  if (a.utmCampaign !== undefined) out.utm_campaign = a.utmCampaign;
  return out;
}

function config() {
  const url = process.env.SHORT_LINKS_API_URL;
  const key = process.env.SHORT_LINKS_API_KEY;
  if (!url || !key) {
    throw new ShortLinksApiError(
      503,
      "SHORT_LINKS_API_URL and SHORT_LINKS_API_KEY must be set",
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function call<T>(
  path: string,
  init: RequestInit & { expectStatus?: number } = {},
): Promise<T> {
  const { url, key } = config();
  const res = await fetch(`${url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const expect = init.expectStatus;
  if (expect != null && res.status === expect) {
    return undefined as T;
  }

  if (!res.ok) {
    let message = `short-links API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* leave message as HTTP status */
    }
    throw new ShortLinksApiError(res.status, message);
  }

  return (await res.json()) as T;
}

export async function listShortLinks(
  opts: { includeArchived?: boolean; tag?: string } = {},
): Promise<ShortLink[]> {
  const params = new URLSearchParams();
  if (opts.includeArchived) params.set("include_archived", "true");
  if (opts.tag) params.set("tag", opts.tag);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const body = await call<{ short_links: RawShortLink[] }>(`/short_links${qs}`);
  return body.short_links.map(normalize);
}

export async function getShortLink(slug: string): Promise<ShortLink | null> {
  try {
    const body = await call<{ short_link: RawShortLink }>(
      `/short_links/${encodeURIComponent(slug)}`,
    );
    return normalize(body.short_link);
  } catch (err) {
    if (err instanceof ShortLinksApiError && err.status === 404) return null;
    throw err;
  }
}

export async function createShortLink(
  input: {
    slug: string;
    destinationUrl: string;
    tag?: string | null;
  } & ShortLinkContentAssociation,
): Promise<ShortLink> {
  const body = await call<{ short_link: RawShortLink }>(`/short_links`, {
    method: "POST",
    body: JSON.stringify({
      short_link: {
        slug: input.slug,
        destination_url: input.destinationUrl,
        tag: input.tag ?? null,
        ...associationParams(input),
      },
    }),
  });
  return normalize(body.short_link);
}

export async function updateShortLink(
  slug: string,
  input: {
    destinationUrl?: string;
    tag?: string | null;
    archived?: boolean;
  } & ShortLinkContentAssociation,
): Promise<ShortLink> {
  const payload: Record<string, unknown> = associationParams(input);
  if (input.destinationUrl !== undefined) payload.destination_url = input.destinationUrl;
  if (input.tag !== undefined) payload.tag = input.tag;
  if (input.archived !== undefined) payload.archived = input.archived;

  const body = await call<{ short_link: RawShortLink }>(
    `/short_links/${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ short_link: payload }),
    },
  );
  return normalize(body.short_link);
}

// All tracking links minted for one production item (normally 0 or 1, since we
// mint one per post). Used to reuse an existing slug on regenerate and to read
// back the click count for the content-detail analytics surface.
export async function findShortLinksByContent(
  contentExternalId: string,
): Promise<ShortLink[]> {
  const body = await call<{ short_links: RawShortLink[] }>(
    `/short_links?content_external_id=${encodeURIComponent(contentExternalId)}&include_archived=true`,
  );
  return body.short_links.map(normalize);
}

export async function deleteShortLink(slug: string): Promise<void> {
  await call<void>(`/short_links/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    expectStatus: 204,
  });
}
