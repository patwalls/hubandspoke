import { NextRequest, NextResponse } from "next/server";
import { auth, signOut } from "@/lib/auth";
import { currentRoleAndBrands } from "@/lib/brand-access";

/**
 * Silent sign-out for a deactivated (or deleted) account whose JWT is still
 * valid. The dashboard layout redirects here; we clear the session cookie and
 * land them on /login with no mention of deactivation (Sam, 2026-10-28).
 *
 * Only signs out when the account really is gone — for an active user it's a
 * no-op redirect home, so this URL can't be used to log other people out.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (userId) {
    const current = await currentRoleAndBrands(userId);
    if (current && !current.deactivatedAt) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    await signOut({ redirectTo: "/login" });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}
