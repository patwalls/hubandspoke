/**
 * Authentication for `/api/v1/**` and the MCP endpoint.
 *
 * Two ways in, checked in this order:
 *   1. `Authorization: Bearer hs_live_…` (or `X-API-Key: hs_live_…`) — an API
 *      key from /developers. The key acts as its owner.
 *   2. The dashboard session cookie — so the "Try it" panel on /developers and
 *      a signed-in browser tab can call the API without creating a key.
 *
 * Either way the principal is a `users` row that is not deactivated. The
 * public API is read-only in v1, so a creator's view-everything right is all
 * it needs; when a write endpoint lands it must gate with `requireBrandEdit`
 * semantics on the principal's role + brand_ids, exactly like the app routes.
 */
import { NextResponse } from "next/server";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { currentRoleAndBrands } from "@/lib/brand-access";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { ApiError, apiError } from "./http";
import {
  apiKeyProblem,
  recordApiRequest,
  resolveApiKey,
  touchApiKey,
  type ApiRequestLog,
} from "./keys";
import { apiRateLimiter, rateLimitHeaders, type RateLimitResult } from "./rate-limit";

export interface ApiPrincipal {
  user: { id: string; email: string; name: string | null; role: "admin" | "creator" };
  auth: "api_key" | "session";
  key: { id: string; name: string; keyPrefix: string; createdAt: Date } | null;
  rateLimit: RateLimitResult;
}

function presentedKey(request: Request): string | null {
  const authz = request.headers.get("authorization");
  if (authz) {
    const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (m) return m[1].trim();
  }
  const x = request.headers.get("x-api-key");
  return x ? x.trim() : null;
}

const PROBLEM_MESSAGE = {
  revoked: "This API key was revoked. Create a new one on the Developers page.",
  expired: "This API key has expired. Create a new one on the Developers page.",
  user_deactivated: "The account that owns this API key is deactivated.",
} as const;

/** Resolve the caller or throw an ApiError (401 / 429). */
export async function authenticateApi(request: Request): Promise<ApiPrincipal> {
  const presented = presentedKey(request);
  if (presented) {
    const resolved = await resolveApiKey(presented);
    if (!resolved) {
      throw new ApiError(
        "unauthorized",
        "Invalid API key. Keys start with hs_live_ and are created on the Developers page.",
      );
    }
    const problem = apiKeyProblem(resolved);
    if (problem) throw new ApiError("unauthorized", PROBLEM_MESSAGE[problem]);
    const rateLimit = apiRateLimiter.hit(`key:${resolved.key.id}`);
    if (!rateLimit.allowed) {
      throw new ApiError("rate_limited", `Rate limit is ${rateLimit.limit} requests per minute per key.`);
    }
    return {
      user: {
        id: resolved.user.id,
        email: resolved.user.email,
        name: resolved.user.name,
        role: resolved.user.role,
      },
      auth: "api_key",
      key: {
        id: resolved.key.id,
        name: resolved.key.name,
        keyPrefix: resolved.key.keyPrefix,
        createdAt: resolved.key.createdAt,
      },
      rateLimit,
    };
  }

  const session = await auth();
  if (!session?.user?.id) {
    throw new ApiError(
      "unauthorized",
      "Missing API key. Send it as `Authorization: Bearer hs_live_…`. Create one on the Developers page.",
    );
  }
  const current = await currentRoleAndBrands(session.user.id);
  if (!current || current.deactivatedAt) {
    throw new ApiError("unauthorized", "Your account is deactivated.");
  }
  const [row] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const rateLimit = apiRateLimiter.hit(`user:${session.user.id}`);
  if (!rateLimit.allowed) {
    throw new ApiError("rate_limited", `Rate limit is ${rateLimit.limit} requests per minute.`);
  }
  return {
    user: {
      id: session.user.id,
      email: row?.email ?? session.user.email ?? "",
      name: row?.name ?? null,
      role: current.role,
    },
    auth: "session",
    key: null,
    rateLimit,
  };
}

export interface ApiHandlerContext {
  principal: ApiPrincipal;
  url: URL;
  request: Request;
}

/**
 * Wrap a v1 route handler: authenticate, run, convert thrown ApiErrors into
 * JSON errors, attach rate-limit headers, and record the request after the
 * response goes out. `route` is the OpenAPI path pattern for the log.
 */
export function v1Handler(
  route: string,
  fn: (ctx: ApiHandlerContext) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const started = performance.now();
    let principal: ApiPrincipal | null = null;
    let response: NextResponse;
    try {
      principal = await authenticateApi(request);
      response = await fn({ principal, url: new URL(request.url), request });
    } catch (err) {
      if (err instanceof ApiError) {
        response = apiError(err);
      } else {
        console.error(`[api:v1] ${route} failed`, err);
        response = apiError(new ApiError("internal_error", "Something went wrong on our side."));
      }
    }
    if (principal) {
      for (const [k, v] of Object.entries(rateLimitHeaders(principal.rateLimit))) {
        response.headers.set(k, v);
      }
    }
    const log: ApiRequestLog = {
      apiKeyId: principal?.key?.id ?? null,
      userId: principal?.user.id ?? null,
      source: "rest",
      method: request.method,
      route,
      status: response.status,
      durationMs: performance.now() - started,
    };
    after(() => persistRequest(log));
    return response;
  };
}

export async function persistRequest(log: ApiRequestLog): Promise<void> {
  try {
    // Anonymous failures (bad key, no session) are not logged: there is no
    // owner to show them to, and logging them would let a scanner fill the table.
    if (!log.userId) return;
    await recordApiRequest(log);
    if (log.apiKeyId) await touchApiKey(log.apiKeyId);
  } catch (err) {
    console.error("[api:v1] request log failed", err);
  }
}
