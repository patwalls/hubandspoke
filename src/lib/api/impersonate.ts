/**
 * Run the app's own route handlers AS an API principal.
 *
 * The write endpoints under /api/v1 don't re-implement status changes,
 * publishing, comments or clip-idea triage — those handlers carry years of
 * invariants (Published needs a link, kills need a reason, Notion pushes,
 * notifications, activity events). Instead the v1 route builds the same
 * request the UI would send and calls the handler directly, inside an
 * AsyncLocalStorage scope that makes `requireSession` / `requireBrandEdit`
 * see the key's owner instead of a cookie. Same gate, same side effects,
 * one code path.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "next-auth";
import { NextRequest, type NextResponse } from "next/server";
import type { ApiPrincipal } from "./auth";
import { ApiError, type ApiErrorType } from "./http";

const store = new AsyncLocalStorage<Session>();

/** The impersonated session for the current async scope, if any. */
export function impersonatedSession(): Session | undefined {
  return store.getStore();
}

export function sessionFor(principal: ApiPrincipal): Session {
  return {
    user: {
      id: principal.user.id,
      email: principal.user.email,
      name: principal.user.name ?? undefined,
      role: principal.user.role,
    },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

export function runAs<T>(principal: ApiPrincipal, fn: () => Promise<T>): Promise<T> {
  return store.run(sessionFor(principal), fn);
}

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<NextResponse | Response>;

const STATUS_TO_TYPE: Record<number, ApiErrorType> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

/**
 * Call an app route handler as `principal`. Non-2xx responses become
 * ApiErrors with the handler's message so the caller gets the same wording
 * the UI shows. Returns the parsed JSON body on success.
 */
export async function callInternal<T = unknown>(
  principal: ApiPrincipal,
  handler: Handler,
  opts: { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; params?: Record<string, string> },
): Promise<T> {
  const request = new NextRequest(new URL(opts.path, "http://internal.hubandspoke"), {
    method: opts.method,
    headers: { "content-type": "application/json", "x-hubandspoke-internal": "api-v1" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const response = await runAs(principal, () => handler(request, { params: Promise.resolve(opts.params ?? {}) }));
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (response.ok) return json as T;
  const body = (json ?? {}) as { error?: unknown; message?: unknown; existingItemId?: unknown };
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : `The request failed (${response.status}).`;
  const type = STATUS_TO_TYPE[response.status] ?? "internal_error";
  const details =
    typeof body.error === "string" && typeof body.message === "string"
      ? { code: body.error, ...(body.existingItemId ? { existing_id: body.existingItemId } : {}) }
      : undefined;
  throw new ApiError(type, message, details);
}
