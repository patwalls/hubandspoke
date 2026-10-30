/**
 * API key lifecycle. The plaintext key is `hs_live_<32 base62 chars>`; we
 * store only its SHA-256 (`api_keys.key_hash`) plus a display prefix. Keys
 * are compared by hashing the presented key and looking the hash up — one
 * indexed equality query, no bcrypt (the secret has 190 bits of entropy, so
 * a fast hash is the right tool and keeps every API call cheap).
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, apiRequests, users, type ApiKeyScope } from "@/lib/db/schema";

export const API_KEY_PREFIX = "hs_live_";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_LENGTH = 32;
/** How many characters of the key we keep in clear for display. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;

export function generateApiKeySecret(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(SECRET_LENGTH);
  let out = "";
  for (let i = 0; i < SECRET_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return API_KEY_PREFIX + out;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function displayPrefix(key: string): string {
  return key.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Does this string even look like one of our keys? Cheap pre-check before a DB hit. */
export function looksLikeApiKey(value: string): boolean {
  return (
    value.startsWith(API_KEY_PREFIX) &&
    value.length === API_KEY_PREFIX.length + SECRET_LENGTH &&
    /^[A-Za-z0-9]+$/.test(value.slice(API_KEY_PREFIX.length))
  );
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  lastUsedAt: string | null;
  requestCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  owner?: { id: string; email: string; name: string | null };
}

function toSummary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    requestCount: row.requestCount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const MAX_KEY_NAME_LENGTH = 60;
export const MAX_ACTIVE_KEYS_PER_USER = 20;

export async function createApiKey(opts: {
  userId: string;
  name: string;
  expiresAt?: Date | null;
  scopes?: ApiKeyScope[];
}): Promise<{ key: string; summary: ApiKeySummary }> {
  const scopes: ApiKeyScope[] = opts.scopes?.includes("write") ? ["read", "write"] : ["read"];
  const name = opts.name.trim().slice(0, MAX_KEY_NAME_LENGTH) || "Untitled key";
  const key = generateApiKeySecret();
  const [row] = await db
    .insert(apiKeys)
    .values({
      userId: opts.userId,
      name,
      keyPrefix: displayPrefix(key),
      keyHash: hashApiKey(key),
      scopes,
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();
  return { key, summary: toSummary(row) };
}

export async function countActiveKeys(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)));
  return row?.n ?? 0;
}

/** Keys owned by one user, newest first. Revoked keys are included (greyed in the UI). */
export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toSummary);
}

/** Every key in the workspace with its owner — admins only (checked by the caller). */
export async function listAllApiKeys(): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({ key: apiKeys, owner: { id: users.id, email: users.email, name: users.name } })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((r) => ({ ...toSummary(r.key), owner: r.owner }));
}

/** Soft-revoke. Returns false when the key doesn't exist or belongs to someone else. */
export async function revokeApiKey(opts: {
  keyId: string;
  userId: string;
  /** Admins may revoke anyone's key. */
  isAdmin?: boolean;
}): Promise<boolean> {
  const where = opts.isAdmin
    ? eq(apiKeys.id, opts.keyId)
    : and(eq(apiKeys.id, opts.keyId), eq(apiKeys.userId, opts.userId));
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(where, isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export interface ResolvedApiKey {
  key: typeof apiKeys.$inferSelect;
  user: {
    id: string;
    email: string;
    name: string | null;
    role: "admin" | "creator";
    deactivatedAt: Date | null;
  };
}

/**
 * Resolve a presented key to its row + owner. `null` for unknown keys.
 * Revoked / expired keys and deactivated owners are returned (not null) so the
 * caller can answer with a precise error instead of a generic "invalid key".
 */
export async function resolveApiKey(presented: string): Promise<ResolvedApiKey | null> {
  if (!looksLikeApiKey(presented)) return null;
  const [row] = await db
    .select({
      key: apiKeys,
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        deactivatedAt: users.deactivatedAt,
      },
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hashApiKey(presented)))
    .limit(1);
  return row ?? null;
}

export function apiKeyProblem(
  resolved: ResolvedApiKey,
  now: Date = new Date(),
): "revoked" | "expired" | "user_deactivated" | null {
  if (resolved.key.revokedAt) return "revoked";
  if (resolved.key.expiresAt && resolved.key.expiresAt <= now) return "expired";
  if (resolved.user.deactivatedAt) return "user_deactivated";
  return null;
}

export async function touchApiKey(keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(), requestCount: sql`${apiKeys.requestCount} + 1` })
    .where(eq(apiKeys.id, keyId));
}

export interface ApiRequestLog {
  apiKeyId: string | null;
  userId: string | null;
  source: "rest" | "mcp";
  method: string;
  route: string;
  tool?: string | null;
  status: number;
  durationMs: number;
}

export async function recordApiRequest(log: ApiRequestLog): Promise<void> {
  await db.insert(apiRequests).values({
    apiKeyId: log.apiKeyId,
    userId: log.userId,
    source: log.source,
    method: log.method,
    route: log.route,
    tool: log.tool ?? null,
    status: log.status,
    durationMs: Math.max(0, Math.round(log.durationMs)),
  });
}

export interface RecentApiRequest {
  id: string;
  createdAt: string;
  source: "rest" | "mcp";
  method: string;
  route: string;
  tool: string | null;
  status: number;
  durationMs: number | null;
  key: { id: string; name: string; keyPrefix: string } | null;
  owner: { id: string; email: string; name: string | null } | null;
}

/** Most recent requests — one user's (via their keys) or, for admins, everyone's. */
export async function listRecentApiRequests(opts: {
  userId: string;
  all?: boolean;
  limit?: number;
}): Promise<RecentApiRequest[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      req: apiRequests,
      key: { id: apiKeys.id, name: apiKeys.name, keyPrefix: apiKeys.keyPrefix },
      owner: { id: users.id, email: users.email, name: users.name },
    })
    .from(apiRequests)
    .leftJoin(apiKeys, eq(apiKeys.id, apiRequests.apiKeyId))
    .leftJoin(users, eq(users.id, apiRequests.userId))
    .where(opts.all ? undefined : eq(apiRequests.userId, opts.userId))
    .orderBy(desc(apiRequests.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.req.id,
    createdAt: r.req.createdAt.toISOString(),
    source: r.req.source,
    method: r.req.method,
    route: r.req.route,
    tool: r.req.tool,
    status: r.req.status,
    durationMs: r.req.durationMs,
    key: r.key?.id ? r.key : null,
    owner: r.owner?.id ? r.owner : null,
  }));
}
