import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import { setSentrySessionUser } from "@/lib/sentry-user";
import { isFeatureEnabled, type FeatureFlag } from "@/lib/feature-flags";

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
  if (session.user.role !== "admin") {
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

export function isAdmin(session: Session | null | undefined): boolean {
  return session?.user?.role === "admin";
}
