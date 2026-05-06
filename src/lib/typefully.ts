import { createHmac, timingSafeEqual } from "node:crypto";

const BASE_URL = "https://api.typefully.com";

function authHeader(): string {
  const token = process.env.TYPEFULLY_API_TOKEN;
  if (!token) throw new Error("TYPEFULLY_API_TOKEN not set");
  return `Bearer ${token}`;
}

export type TypefullyPlatform = "x" | "linkedin";

export type TypefullyStatus =
  | "draft"
  | "scheduled"
  | "published"
  | "publishing"
  | "error";

export interface TypefullyDraft {
  id: number;
  social_set_id: number;
  status: TypefullyStatus;
  scheduled_date: string | null;
  published_at: string | null;
  share_url: string | null;
  private_url: string;
  draft_title: string | null;
  x_published_url?: string | null;
  linkedin_published_url?: string | null;
  x_post_published_at?: string | null;
  linkedin_post_published_at?: string | null;
}

interface CreateDraftArgs {
  socialSetId: number;
  platform: TypefullyPlatform;
  text: string;
  draftTitle?: string;
}

export async function createTypefullyDraft(
  args: CreateDraftArgs,
): Promise<TypefullyDraft> {
  const body = {
    platforms: {
      [args.platform]: {
        enabled: true,
        posts: [{ text: args.text }],
      },
    },
    ...(args.draftTitle ? { draft_title: args.draftTitle } : {}),
  };
  const res = await fetch(
    `${BASE_URL}/v2/social-sets/${args.socialSetId}/drafts`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(),
      },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (json && (json.message || json.detail || json.error)) ||
      `HTTP ${res.status}`;
    throw new Error(`Typefully createDraft failed: ${msg}`);
  }
  return json as TypefullyDraft;
}

export async function fetchTypefullyDraft(args: {
  socialSetId: number;
  draftId: number;
}): Promise<TypefullyDraft> {
  const res = await fetch(
    `${BASE_URL}/v2/social-sets/${args.socialSetId}/drafts/${args.draftId}?exclude_comment_markers=true`,
    { headers: { Authorization: authHeader() } },
  );
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (json && (json.message || json.detail || json.error)) ||
      `HTTP ${res.status}`;
    throw new Error(`Typefully fetchDraft failed: ${msg}`);
  }
  return json as TypefullyDraft;
}

/**
 * Verify the X-Typefully-Signature header against the raw request body.
 * Recipe per Typefully docs:
 *   payload = `${timestamp}.${rawBody}`
 *   expected = `sha256=${hmac_sha256(secret, payload).hex()}`
 * Returns false on any malformed input rather than throwing — caller
 * decides the HTTP response.
 */
export function verifyTypefullySignature(args: {
  rawBody: string;
  timestamp: string | null;
  signatureHeader: string | null;
  secret: string;
}): boolean {
  if (!args.timestamp || !args.signatureHeader) return false;
  const payload = `${args.timestamp}.${args.rawBody}`;
  const expected =
    "sha256=" +
    createHmac("sha256", args.secret).update(payload).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
