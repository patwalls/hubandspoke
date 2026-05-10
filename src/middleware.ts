import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

const PUBLIC_PAGES = new Set([
  "/login",
  "/forgot-password",
  "/reset-password",
  "/accept-invite",
]);

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isAuthApi = pathname.startsWith("/api/auth");
  const isCronApi = pathname.startsWith("/api/cron");
  // Inbound webhooks (Typefully today; future ones will live under the
  // same prefix). Auth is handled per-route via signature verification —
  // gating on session here would 401 every external delivery before it
  // reaches the verifier (which is exactly what disabled the Typefully
  // webhook twice now).
  const isWebhookApi = pathname.startsWith("/api/webhooks");
  const isInviteApi =
    pathname === "/api/invites/validate" ||
    pathname === "/api/invites/accept";
  if (isAuthApi || isCronApi || isWebhookApi || isInviteApi)
    return NextResponse.next();

  const isPublic = PUBLIC_PAGES.has(pathname);
  const loggedIn = !!req.auth;

  if (loggedIn) {
    if (isPublic) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (isPublic) return NextResponse.next();
  if (pathname.startsWith("/api")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
