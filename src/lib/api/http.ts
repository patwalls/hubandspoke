/**
 * Response shapes for `/api/v1`. Every success is `{ data, ... }`, every
 * failure `{ error: { type, message } }` with a matching HTTP status, so a
 * client can branch on one field. `type` values are stable identifiers
 * (documented on /developers); `message` is for humans and may change.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export type ApiErrorType =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ApiErrorType, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  rate_limited: 429,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly type: ApiErrorType,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.type];
  }
}

export function errorBody(err: ApiError) {
  return {
    error: {
      type: err.type,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}

export function apiError(err: ApiError, headers?: HeadersInit): NextResponse {
  const h = new Headers(headers);
  if (err.type === "unauthorized") h.set("WWW-Authenticate", 'Bearer realm="hubandspoke"');
  return NextResponse.json(errorBody(err), { status: err.status, headers: h });
}

export function apiJson(body: unknown, init?: { status?: number; headers?: HeadersInit }): NextResponse {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { "Cache-Control": "no-store", ...Object.fromEntries(new Headers(init?.headers)) },
  });
}

/** Parse query params with a zod schema; a failure is a 400 with the field errors. */
export function parseQuery<T extends z.ZodTypeAny>(url: URL, schema: T): z.infer<T> {
  const raw: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    raw[k] = v;
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(
      "invalid_request",
      "One or more query parameters are invalid.",
      result.error.issues.map((i) => ({ param: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string, what = "id"): string {
  if (!UUID_RE.test(value)) {
    throw new ApiError("invalid_request", `${what} must be a UUID.`);
  }
  return value.toLowerCase();
}

/** The UUID path segment right after `after` (`/api/v1/content/<id>/transcript` → id). */
export function idFromPath(url: URL, after: string): string {
  const parts = url.pathname.split("/");
  const i = parts.indexOf(after);
  return requireUuid(parts[i + 1] ?? "", "id");
}

// ── Opaque cursors ─────────────────────────────────────────────────────────

export interface ContentCursor {
  /** ISO timestamp of the last row's sort key. */
  t: string;
  id: string;
}

export function encodeCursor(c: ContentCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): ContentCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ContentCursor).t === "string" &&
      typeof (parsed as ContentCursor).id === "string" &&
      !Number.isNaN(Date.parse((parsed as ContentCursor).t)) &&
      UUID_RE.test((parsed as ContentCursor).id)
    ) {
      return { t: (parsed as ContentCursor).t, id: (parsed as ContentCursor).id.toLowerCase() };
    }
  } catch {
    // fall through
  }
  throw new ApiError("invalid_request", "cursor is not valid. Use the next_cursor from a previous response.");
}

// Shared zod pieces -----------------------------------------------------------

export const zBool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const zLimit = (max = 100, def = 25) =>
  z.coerce.number().int().min(1).max(max).default(def);

export const zIsoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 date or datetime")
  .transform((v) => new Date(v));
