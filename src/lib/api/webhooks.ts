/**
 * Webhook subscriptions: create / list / revoke, secrets and signatures,
 * recent deliveries. Event detection and delivery live in
 * src/lib/services/webhook-dispatch.ts and the worker tasks.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiWebhookDeliveries, apiWebhooks, users } from "@/lib/db/schema";
import { WEBHOOK_EVENTS, type WebhookEvent } from "./constants";
import { ApiError } from "./http";

export const MAX_WEBHOOKS_PER_USER = 10;
const SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString("base64url");
}

/** `sha256=<hex hmac of "<timestamp>.<body>">` — the value of X-HubSpoke-Signature. */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = signWebhookBody(secret, timestamp, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ApiWebhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  brand: string | null;
  active: boolean;
  consecutive_failures: number;
  last_delivery_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  owner?: { id: string; email: string; name: string | null };
}

function toApi(row: typeof apiWebhooks.$inferSelect): ApiWebhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as WebhookEvent[],
    brand: row.brand,
    active: row.active,
    consecutive_failures: row.consecutiveFailures,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    last_success_at: row.lastSuccessAt?.toISOString() ?? null,
    last_failure_at: row.lastFailureAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError("invalid_request", "url must be a full https:// URL.");
  }
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0)/.test(url.hostname) || url.hostname.endsWith(".local");
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) {
    throw new ApiError("invalid_request", "url must use https://.");
  }
  if (isLocal && process.env.NODE_ENV === "production") {
    throw new ApiError("invalid_request", "url must be reachable from the internet.");
  }
  return url.toString();
}

export function validateEvents(raw: unknown): WebhookEvent[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError("invalid_request", `events must be a non-empty list from: ${WEBHOOK_EVENTS.join(", ")}.`);
  }
  const out = new Set<WebhookEvent>();
  for (const e of raw) {
    if (typeof e !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(e)) {
      throw new ApiError("invalid_request", `Unknown event "${String(e)}". Valid events: ${WEBHOOK_EVENTS.join(", ")}.`);
    }
    out.add(e as WebhookEvent);
  }
  return [...out];
}

export async function createWebhook(opts: {
  userId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  brand?: string | null;
}): Promise<{ webhook: ApiWebhook; secret: string }> {
  const active = await db
    .select({ id: apiWebhooks.id })
    .from(apiWebhooks)
    .where(and(eq(apiWebhooks.userId, opts.userId), eq(apiWebhooks.active, true)));
  if (active.length >= MAX_WEBHOOKS_PER_USER) {
    throw new ApiError("invalid_request", `You already have ${MAX_WEBHOOKS_PER_USER} active webhooks. Remove one first.`);
  }
  const secret = generateWebhookSecret();
  const [row] = await db
    .insert(apiWebhooks)
    .values({
      userId: opts.userId,
      name: opts.name.trim().slice(0, 60) || "Webhook",
      url: opts.url,
      events: opts.events,
      secret,
      brand: opts.brand || null,
    })
    .returning();
  return { webhook: toApi(row), secret };
}

export async function listWebhooks(opts: { userId: string; all?: boolean }): Promise<ApiWebhook[]> {
  const rows = await db
    .select({ w: apiWebhooks, owner: { id: users.id, email: users.email, name: users.name } })
    .from(apiWebhooks)
    .innerJoin(users, eq(users.id, apiWebhooks.userId))
    .where(opts.all ? undefined : eq(apiWebhooks.userId, opts.userId))
    .orderBy(desc(apiWebhooks.createdAt));
  return rows.map((r) => ({ ...toApi(r.w), ...(opts.all ? { owner: r.owner } : {}) }));
}

export async function getWebhookForUser(id: string, userId: string, isAdmin = false) {
  const [row] = await db
    .select()
    .from(apiWebhooks)
    .where(isAdmin ? eq(apiWebhooks.id, id) : and(eq(apiWebhooks.id, id), eq(apiWebhooks.userId, userId)))
    .limit(1);
  if (!row) throw new ApiError("not_found", `No webhook with id ${id}.`);
  return row;
}

export async function deleteWebhook(opts: { id: string; userId: string; isAdmin?: boolean }): Promise<void> {
  const row = await getWebhookForUser(opts.id, opts.userId, opts.isAdmin);
  await db.delete(apiWebhooks).where(eq(apiWebhooks.id, row.id));
}

export async function rotateWebhookSecret(opts: { id: string; userId: string; isAdmin?: boolean }): Promise<string> {
  const row = await getWebhookForUser(opts.id, opts.userId, opts.isAdmin);
  const secret = generateWebhookSecret();
  await db.update(apiWebhooks).set({ secret, updatedAt: new Date() }).where(eq(apiWebhooks.id, row.id));
  return secret;
}

export async function setWebhookActive(opts: { id: string; userId: string; isAdmin?: boolean; active: boolean }): Promise<ApiWebhook> {
  const row = await getWebhookForUser(opts.id, opts.userId, opts.isAdmin);
  const [updated] = await db
    .update(apiWebhooks)
    .set({ active: opts.active, consecutiveFailures: opts.active ? 0 : row.consecutiveFailures, updatedAt: new Date() })
    .where(eq(apiWebhooks.id, row.id))
    .returning();
  return toApi(updated);
}

export interface ApiDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  payload: unknown;
  created_at: string;
  delivered_at: string | null;
}

export async function listDeliveries(opts: { userId: string; webhookId?: string; all?: boolean; limit?: number }): Promise<ApiDelivery[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const hooks = await db
    .select({ id: apiWebhooks.id })
    .from(apiWebhooks)
    .where(opts.all ? undefined : eq(apiWebhooks.userId, opts.userId));
  const ids = hooks.map((h) => h.id).filter((id) => !opts.webhookId || id === opts.webhookId);
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(apiWebhookDeliveries)
    .where(inArray(apiWebhookDeliveries.webhookId, ids))
    .orderBy(desc(apiWebhookDeliveries.createdAt))
    .limit(limit);
  return rows.map((d) => ({
    id: d.id,
    webhook_id: d.webhookId,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    last_status_code: d.lastStatusCode,
    last_error: d.lastError,
    payload: d.payload,
    created_at: d.createdAt.toISOString(),
    delivered_at: d.deliveredAt?.toISOString() ?? null,
  }));
}
