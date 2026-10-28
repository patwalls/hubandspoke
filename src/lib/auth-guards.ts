import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { setSentrySessionUser } from "@/lib/sentry-user";
import { isFeatureEnabled, type FeatureFlag } from "@/lib/feature-flags";
import { canEditBrand, currentRoleAndBrands } from "@/lib/brand-access";

export type GuardResult =
  | { session: Session; response?: undefined }
  | { session?: undefined; response: NextResponse };

export async function requireSession(): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  setSentrySessionUser(session);
  return { session };
}

export async function requireAdmin(): Promise<GuardResult> {
  const session = await auth();
  if (!session?.user) {
    return {
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  // DB role, not the JWT's — a demotion must apply without a re-login.
  const current = await currentRoleAndBrands(session.user.id);
  if (current?.role !== "admin") {
    return {
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  setSentrySessionUser(session);
  return { session };
}

/**
 * Gate a route behind a per-user feature flag (src/lib/feature-flags.ts).
 * Responds 404 — not 403 — to users without the flag, so an unreleased
 * feature's endpoints are indistinguishable from routes that don't exist.
 */
export async function requireFeature(flag: FeatureFlag): Promise<GuardResult> {
  const guard = await requireSession();
  if (guard.response) return guard;
  if (!isFeatureEnabled(flag, guard.session.user)) {
    return {
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return guard;
}

/**
 * Gate a mutating route on edit access to one brand (src/lib/brand-access.ts).
 * Pass the brand slug of the record being changed — usually from a resolver
 * like `brandOfProductionItem(id)`. `null` (record not found) responds 404.
 *
 *   const guard = await requireBrandEdit(await brandOfProductionItem(id));
 *   if (guard.response) return guard.response;
 */
export async function requireBrandEdit(
  brandSlug: string | null | undefined
): Promise<GuardResult> {
  const guard = await requireSession();
  if (guard.response) return guard;
  if (!brandSlug) {
    return {
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  if (!(await canEditBrand(guard.session, brandSlug))) {
    return {
      response: NextResponse.json(
        { error: "You have view-only access to this brand. Ask an admin for edit access." },
        { status: 403 }
      ),
    };
  }
  return guard;
}

/** JWT role — frozen at sign-in. Prefer `isAdminNow` (src/lib/brand-access.ts). */
export function isAdmin(session: Session | null | undefined): boolean {
  return session?.user?.role === "admin";
}
