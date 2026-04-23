import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Proxy for Meta-CDN images (fbcdn.net, cdninstagram.com). Those CDNs
 * serve images with `Cross-Origin-Resource-Policy: same-origin`, which
 * makes browsers refuse to render them from our domain even though the
 * URL itself returns 200. Streaming the bytes through our own origin
 * strips that header so the `<img>` actually renders.
 *
 * Host allow-list keeps this from becoming an open proxy. Auth-gated so
 * random callers can't burn our bandwidth.
 */
const ALLOWED_HOST_SUFFIXES = [".fbcdn.net", ".cdninstagram.com"];

function isAllowed(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    return ALLOWED_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const src = request.nextUrl.searchParams.get("url");
  if (!src) return NextResponse.json({ error: "missing url" }, { status: 400 });
  if (!isAllowed(src)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 400 });
  }

  const upstream = await fetch(src, {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `upstream ${upstream.status}` },
      { status: 502 }
    );
  }
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "public, max-age=3600",
    },
  });
}
