import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentComments, contentDrafts, contentEvents, productionItems, users } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import { getPresignedGetUrl } from "@/lib/s3";
import { htmlToPlainText } from "@/lib/comments/sanitize";
import { draftPreview } from "@/lib/production/peek";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const URL_TTL_SECONDS = 60 * 60;

async function presign(key: string | null, bucket?: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await getPresignedGetUrl(key, URL_TTL_SECONDS, { bucket: bucket ?? undefined });
  } catch {
    return null;
  }
}

/**
 * GET /api/production-items/[id]/peek
 *
 * The In Production row peek (production-run M4): enough of a post to judge
 * it without opening the content page — cover / video, hook, the current
 * draft's written fields, the last three comments, and who moved it into its
 * status and when. Four small reads, no LLM; the full page stays
 * `GET /api/production-items/[id]`.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;

  const [item] = await db
    .select({
      id: productionItems.id,
      title: productionItems.title,
      status: productionItems.status,
      brand: productionItems.brand,
      postType: productionItems.postType,
      format: productionItems.format,
      hook: productionItems.hook,
      thumbnail: productionItems.thumbnail,
      posterS3Key: productionItems.posterS3Key,
      mediaS3Key: productionItems.mediaS3Key,
      mediaS3Bucket: productionItems.mediaS3Bucket,
      editorName: users.name,
      editorEmail: users.email,
    })
    .from(productionItems)
    .leftJoin(users, eq(users.id, productionItems.editorUserId))
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const [draftRows, commentRows, statusRows, posterUrl, mediaUrl] = await Promise.all([
    db
      .select({ content: contentDrafts.content, schema: contentDrafts.fieldSchemaSnapshot })
      .from(contentDrafts)
      .where(and(eq(contentDrafts.productionItemId, id), eq(contentDrafts.isCurrent, true)))
      .limit(1),
    db
      .select({
        body: contentComments.body,
        createdAt: contentComments.createdAt,
        authorName: contentComments.authorName,
        userName: users.name,
        userEmail: users.email,
      })
      .from(contentComments)
      .leftJoin(users, eq(users.id, contentComments.userId))
      .where(eq(contentComments.contentItemId, id))
      .orderBy(desc(contentComments.createdAt))
      .limit(3),
    db
      .select({ at: contentEvents.createdAt, byName: users.name, byEmail: users.email })
      .from(contentEvents)
      .leftJoin(users, eq(users.id, contentEvents.userId))
      .where(and(eq(contentEvents.contentItemId, id), eq(contentEvents.eventType, "status_change")))
      .orderBy(desc(contentEvents.createdAt))
      .limit(1),
    presign(item.posterS3Key),
    presign(item.mediaS3Key, item.mediaS3Bucket),
  ]);

  const draft = draftRows[0];
  const moved = statusRows[0];
  return NextResponse.json({
    id: item.id,
    title: item.title,
    status: item.status,
    brand: item.brand,
    postType: item.postType,
    format: item.format,
    editor: item.editorName || item.editorEmail?.split("@")[0] || null,
    hook: item.hook,
    posterUrl: posterUrl ?? item.thumbnail ?? null,
    mediaUrl,
    draft: draftPreview(draft?.content, draft?.schema),
    // Oldest first, as they read on the content page.
    comments: commentRows.reverse().map((c) => ({
      author: c.userName || c.authorName || c.userEmail?.split("@")[0] || "Someone",
      text: htmlToPlainText(c.body).slice(0, 400),
      at: c.createdAt.toISOString(),
    })),
    statusSince: moved
      ? { at: moved.at.toISOString(), by: moved.byName || moved.byEmail?.split("@")[0] || null }
      : null,
  });
}
