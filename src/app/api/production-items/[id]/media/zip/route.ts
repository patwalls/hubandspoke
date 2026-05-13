import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import archiver from "archiver";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { requireSession } from "@/lib/auth-guards";
import { db } from "@/lib/db";
import {
  productionItems,
  productionItemMedia,
} from "@/lib/db/schema";
import { s3Client, bucketName } from "@/lib/s3";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/production-items/[id]/media/zip
 *
 * Stream every `productionItemMedia` row for the item back as a single zip,
 * one entry per slide in carousel order. Used by the "Download all" button
 * on the content-detail page for Canva-generated IG-Post slideshows so an
 * editor can grab all four PNGs (plus the page-3 MP4 once exported) in one
 * click instead of right-click-saving each card individually.
 *
 * Auth: standard session guard, no special permission — anyone who can view
 * the item can grab its media.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({ id: productionItems.id, title: productionItems.title })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      index: productionItemMedia.index,
      kind: productionItemMedia.kind,
      s3Bucket: productionItemMedia.s3Bucket,
      s3Key: productionItemMedia.s3Key,
      contentType: productionItemMedia.contentType,
    })
    .from(productionItemMedia)
    .where(eq(productionItemMedia.productionItemId, id))
    .orderBy(asc(productionItemMedia.index));
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No media to download" },
      { status: 404 },
    );
  }

  // Build a streamable zip. archiver pipes into a Web ReadableStream we
  // hand back via NextResponse — no buffering of full bytes in memory.
  const archive = archiver("zip", { zlib: { level: 6 } });
  const client = s3Client();

  // Pull each S3 object as a stream and append it to the archive. Done in
  // sequence — archiver doesn't deal gracefully with parallel appends, and
  // 4-10 small files don't need parallelism anyway.
  const safeTitle = (item.title ?? "slides")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "slides";

  // Kick off fetches in the background; pipe each into the archive as it
  // arrives. We can't `await` archive.append before responding (the
  // archive is the response body), so this runs asynchronously while we
  // return the readable stream.
  (async () => {
    try {
      for (const row of rows) {
        const ext = extensionFor(row.contentType, row.kind);
        const fileName = `slide-${String(row.index + 1).padStart(2, "0")}.${ext}`;
        const obj = await client.send(
          new GetObjectCommand({
            Bucket: row.s3Bucket ?? bucketName(),
            Key: row.s3Key,
          }),
        );
        if (!obj.Body) {
          console.warn(
            `[media/zip] empty body for ${row.s3Key} (item=${id})`,
          );
          continue;
        }
        archive.append(obj.Body as Readable, { name: fileName });
      }
      await archive.finalize();
    } catch (err) {
      console.error(`[media/zip] stream build failed for item=${id}:`, err);
      archive.abort();
    }
  })();

  return new NextResponse(archive as unknown as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeTitle}-slides.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

function extensionFor(contentType: string | null, kind: string): string {
  if (kind === "video") {
    if (contentType?.includes("mp4")) return "mp4";
    if (contentType?.includes("webm")) return "webm";
    return "mp4";
  }
  if (contentType?.includes("png")) return "png";
  if (contentType?.includes("jpeg") || contentType?.includes("jpg"))
    return "jpg";
  if (contentType?.includes("webp")) return "webp";
  if (contentType?.includes("gif")) return "gif";
  return "bin";
}
