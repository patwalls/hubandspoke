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
  const isInviteApi =
    pathname === "/api/invites/validate" ||
    pathname === "/api/invites/accept";
  // ManyChat's External Request hits /api/manychat/* without a session. The
  // route handler enforces auth via the `x-manychat-secret` header.
  const isManychatApi = pathname.startsWith("/api/manychat");
  // Meta's Instagram webhook hits /api/instagram/* without a session. The
  // route handler enforces auth via the X-Hub-Signature-256 HMAC (and
  // hub.verify_token on the GET handshake).
  const isInstagramApi = pathname.startsWith("/api/instagram");
  if (
    isAuthApi ||
    isCronApi ||
    isInviteApi ||
    isManychatApi ||
    isInstagramApi
  )
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
