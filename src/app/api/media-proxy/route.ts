import { GetObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import { bucketName, s3Client } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/media-proxy?key=<urlencoded-s3-key>&disposition=<inline|download>
 *
 * Streams an S3 object through the app's own origin so the download/copy
 * actions on the content-detail simulator work even when the browser's
 * direct fetch to s3.us-east-1.amazonaws.com is blocked — usually CORS
 * (the bucket's CORS policy doesn't include this origin) or hotel/airport
 * WiFi blocking direct S3 hostnames. The `<img>` tag works in those
 * environments because it doesn't go through CORS; `fetch()` does.
 *
 * Security: the bucket is app-owned but I still validate that the key
 * exists somewhere in our schema (`production_items.media_s3_key` /
 * `poster_s3_key` / `production_item_media.s3_key`) so an authed user
 * can't probe arbitrary S3 keys. 404 on miss.
 *
 * Bytes pass through the web dyno; for the operator-driven download
 * volumes this surface sees (handful per hour) that's a non-issue. If
 * volume grows enough to matter, the right next step is fixing the S3
 * bucket CORS policy at the AWS console — this proxy is the code-level
 * workaround that makes the UX robust regardless of infra state.
 */
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if (guard.response) return guard.response;

  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const disposition =
    request.nextUrl.searchParams.get("disposition") === "download"
      ? "download"
      : "inline";

  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM production_items
      WHERE media_s3_key = ${key} OR poster_s3_key = ${key}
      UNION ALL
      SELECT 1 FROM production_item_media WHERE s3_key = ${key}
    ) AS exists
  `);
  if (!rows[0]?.exists) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const cmd = new GetObjectCommand({ Bucket: bucketName(), Key: key });
    const result = await s3Client().send(cmd);
    if (!result.Body) {
      return NextResponse.json({ error: "empty body" }, { status: 502 });
    }

    const headers = new Headers({
      "Content-Type": result.ContentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=300",
    });
    if (result.ContentLength != null) {
      headers.set("Content-Length", String(result.ContentLength));
    }
    if (disposition === "download") {
      const filename = (key.split("/").pop() ?? "download").replace(/"/g, "");
      headers.set("Content-Disposition", `attachment; filename="${filename}"`);
    }

    // AWS SDK v3 in Node 18+ exposes transformToWebStream() — preserves
    // streaming end-to-end instead of buffering large videos in dyno RAM.
    const stream = result.Body.transformToWebStream();
    return new Response(stream, { headers });
  } catch (err) {
    console.error("[media-proxy] S3 fetch failed:", err);
    return NextResponse.json(
      { error: "S3 fetch failed" },
      { status: 502 },
    );
  }
}
