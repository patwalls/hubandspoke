import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts } from "@/lib/db/schema";
import {
  PLATFORM_FIELD_MAP,
  type PostType,
} from "@/lib/platform-field-schemas";
import { isClipIdeaNotes, pickSourceCaption } from "@/lib/source-caption";

/**
 * The caption a cross-post / repost should copy from its source. Reads the
 * source's current draft only when `content_body` can't be used (empty, or
 * the clip-idea notes block — see `src/lib/source-caption.ts`).
 */
export async function loadSourceCaption(source: {
  id: string;
  contentBody: string | null;
  postType: string | null;
}): Promise<string | null> {
  const body = source.contentBody;
  if (body?.trim() && !isClipIdeaNotes(body)) return body;

  const field = source.postType
    ? PLATFORM_FIELD_MAP[source.postType as PostType]?.caption
    : null;
  if (!field) return pickSourceCaption(body, null);

  const [draft] = await db
    .select({ content: contentDrafts.content })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, source.id),
        eq(contentDrafts.isCurrent, true),
      ),
    )
    .limit(1);
  const value = draft?.content?.[field];
  return pickSourceCaption(body, typeof value === "string" ? value : null);
}
