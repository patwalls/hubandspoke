import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPresignedGetUrl } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

const ALLOWED_PREFIXES = [
  // Anything an authed user uploaded as a comment attachment. Other
  // prefixes (e.g. media uploads) have their own access paths and aren't
  // proxied here to keep this surface narrow.
  "/comment-attachments/",
];

/**
 * Stable, auth-protected proxy for S3 objects. The bucket is private; we
 * issue short-lived presigned GET URLs and 302 the browser to them. Comment
 * bodies store `/api/files/<key>` so the link survives forever even though
 * the underlying signed URL only lives ~15 min.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { key: parts } = await context.params;
  const key = parts.join("/");
  if (!key) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }
  // Whitelist the prefixes this endpoint is allowed to surface. Otherwise
  // any authed user could pull arbitrary keys (transcripts, raw uploads,
  // ffmpeg temp clips) by guessing paths.
  const slashKey = `/${key.replace(/^\/+/, "")}`;
  if (!ALLOWED_PREFIXES.some((p) => slashKey.includes(p))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const url = await getPresignedGetUrl(key, 900);
    return NextResponse.redirect(url, 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
