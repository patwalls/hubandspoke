// Server-only client for the StarterStory Rails app's short-link REST API.
// Callers: the `/settings/links` RSC and the proxy API route under
// `/api/short-links/...`. Never import from a client component — that would
// leak SHORT_LINKS_API_KEY into the browser bundle.
//
// The redirect + click tracking itself lives in the Rails app (the `ShortLink`
// and `ShortLinkClick` models); hubandspoke is only the control plane.

export interface ShortLink {
  slug: string;
  destinationUrl: string;
  clicksCount: number;
  lastClickedAt: string | null;
  tag: string | null;
  archived: boolean;
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
  last_clicked_at: string | null;
  tag: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

function normalize(raw: RawShortLink): ShortLink {
  return {
    slug: raw.slug,
    destinationUrl: raw.destination_url,
    clicksCount: raw.clicks_count,
    lastClickedAt: raw.last_clicked_at,
    tag: raw.tag,
    archived: raw.archived,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
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

export async function listShortLinks(opts: { includeArchived?: boolean } = {}): Promise<ShortLink[]> {
  const qs = opts.includeArchived ? "?include_archived=true" : "";
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

export async function createShortLink(input: {
  slug: string;
  destinationUrl: string;
  tag?: string | null;
}): Promise<ShortLink> {
  const body = await call<{ short_link: RawShortLink }>(`/short_links`, {
    method: "POST",
    body: JSON.stringify({
      short_link: {
        slug: input.slug,
        destination_url: input.destinationUrl,
        tag: input.tag ?? null,
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
  },
): Promise<ShortLink> {
  const payload: Record<string, unknown> = {};
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

export async function deleteShortLink(slug: string): Promise<void> {
  await call<void>(`/short_links/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    expectStatus: 204,
  });
}
