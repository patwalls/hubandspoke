// Server-only client for StarterStory's content catalog REST API (the Rails
// app's /api/v1/lead_magnets and /api/v1/content endpoints). Used by the CTA
// generator to choose a target: a guest's episode (searchContent) or, as a
// fallback, the best-matching lead magnet (listLeadMagnets).
//
// Mirrors the auth + config of `short-links.ts` (same base URL + bearer key) —
// never import from a client component; that would leak SHORT_LINKS_API_KEY.

export interface LeadMagnet {
  id: number;
  src: string | null;
  title: string | null;
  slug: string | null;
  /** Absolute public landing-page URL the CTA should drive clicks to. */
  url: string | null;
  description: string | null;
  imageUrl: string | null;
}

export interface ContentResult {
  id: number;
  title: string | null;
  slug: string | null;
  /** Absolute URL of the published episode/page. */
  url: string | null;
  contentType: string | null;
  publishedAt: string | null;
  summary: string | null;
  businessName: string | null;
  hasVideo: boolean;
}

export class ContentApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function config() {
  const url = process.env.SHORT_LINKS_API_URL;
  const key = process.env.SHORT_LINKS_API_KEY;
  if (!url || !key) {
    throw new ContentApiError(
      503,
      "SHORT_LINKS_API_URL and SHORT_LINKS_API_KEY must be set",
    );
  }
  return { url: url.replace(/\/$/, ""), key };
}

async function call<T>(path: string): Promise<T> {
  const { url, key } = config();
  const res = await fetch(`${url}${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    let message = `content API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* leave message as HTTP status */
    }
    throw new ContentApiError(res.status, message);
  }

  return (await res.json()) as T;
}

type RawLeadMagnet = {
  id: number;
  src: string | null;
  title: string | null;
  slug: string | null;
  url: string | null;
  description: string | null;
  image_url: string | null;
};

type RawContent = {
  id: number;
  title: string | null;
  slug: string | null;
  url: string | null;
  content_type: string | null;
  published_at: string | null;
  summary: string | null;
  business_name: string | null;
  has_video: boolean;
};

export async function listLeadMagnets(): Promise<LeadMagnet[]> {
  const body = await call<{ lead_magnets: RawLeadMagnet[] }>(`/lead_magnets`);
  return body.lead_magnets.map((m) => ({
    id: m.id,
    src: m.src,
    title: m.title,
    slug: m.slug,
    url: m.url,
    description: m.description,
    imageUrl: m.image_url ?? null,
  }));
}

export async function searchContent(opts: {
  q?: string;
  contentType?: string;
  limit?: number;
  all?: boolean;
}): Promise<ContentResult[]> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.contentType) params.set("content_type", opts.contentType);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.all) params.set("all", "true");
  const qs = params.toString() ? `?${params.toString()}` : "";
  const body = await call<{ content: RawContent[] }>(`/content${qs}`);
  return body.content.map((c) => ({
    id: c.id,
    title: c.title,
    slug: c.slug,
    url: c.url,
    contentType: c.content_type,
    publishedAt: c.published_at,
    summary: c.summary,
    businessName: c.business_name,
    hasVideo: c.has_video,
  }));
}
