/**
 * Every API route checks who's calling itself (S-167 / S-169).
 *
 * The middleware only verifies the JWT signature — it can't see the DB, so a
 * deleted teammate's cookie sails through it, and its matcher once skipped
 * any path ending in .png. A route is safe only when it calls a guard that
 * looks the user up (`requireSession` & co. in src/lib/auth-guards.ts, or
 * `v1Handler` / `authenticateApi` for the public API), or it is on the
 * explicit public list below with its own check (signature, CRON_SECRET,
 * one-time token).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const API = join(__dirname);
const routes: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === "route.ts") routes.push(relative(API, p));
  }
})(API);

const GUARD = /\b(requireSession|requireAdmin|requireFeature|requireBrandEdit)\(|\bv1Handler\(|\bauthenticateApi\(/;

/** Public on purpose — each has its own check, named here. */
const PUBLIC: Record<string, string> = {
  "auth/[...nextauth]/route.ts": "NextAuth itself",
  "auth/end-session/route.ts": "signs the caller out",
  "auth/forgot-password/route.ts": "anonymous by design; throttled, always 200",
  "auth/reset-password/route.ts": "one-time hashed token",
  "invites/validate/route.ts": "one-time hashed token",
  "invites/accept/route.ts": "one-time hashed token",
  "health/queue/route.ts": "public health probe, no data",
  "health/worker/route.ts": "public health probe, no data",
  "warm/route.ts": "Bearer CRON_SECRET",
  "cron/tick/route.ts": "Bearer CRON_SECRET",
  "cron/enrichment-sweep/route.ts": "Bearer CRON_SECRET",
  "cron/notion-sync/route.ts": "Bearer CRON_SECRET",
  "cron/performance-sync/route.ts": "Bearer CRON_SECRET",
  "webhooks/typefully/route.ts": "HMAC signature",
  "webhooks/zernio/route.ts": "HMAC signature",
  "webhooks/feedhook/route.ts": "HMAC signature",
  "v1/openapi.json/route.ts": "public API spec, no data",
};

describe("API route guards", () => {
  it("finds the routes", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("every route calls a DB-checking guard or is on the public list", () => {
    const unguarded = routes.filter((r) => !PUBLIC[r] && !GUARD.test(readFileSync(join(API, r), "utf8")));
    expect(unguarded, "add requireSession() (or list it in PUBLIC with its own check)").toEqual([]);
  });

  it("no route trusts a bare auth() — it skips the deleted/deactivated check", () => {
    const bare = routes.filter((r) => r !== "auth/end-session/route.ts" && /await auth\(\)/.test(readFileSync(join(API, r), "utf8")));
    expect(bare, "use requireSession() instead of auth()").toEqual([]);
  });

  it("CRON_SECRET checks fail closed when the secret is unset", () => {
    const failOpen = routes.filter((r) => /if \(\s*\w*[sS]ecret\s*&&/.test(readFileSync(join(API, r), "utf8")));
    expect(failOpen, "use `if (!secret || header !== ...)`").toEqual([]);
  });

  it("the public list only names routes that exist", () => {
    expect(Object.keys(PUBLIC).filter((r) => !routes.includes(r))).toEqual([]);
  });

  it("middleware runs on every /api path, even ones ending in .png", () => {
    const mw = readFileSync(join(API, "../../middleware.ts"), "utf8");
    expect(mw).toContain('"/api/:path*"');
  });
});
