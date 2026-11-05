import { and, eq, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { academyVideos } from "@/lib/db/schema";
import { slugify } from "@/lib/academy/validate";

/** A slug not used by another video: "cross-posts", "cross-posts-2", … */
export async function uniqueVideoSlug(title: string): Promise<string> {
  const base = slugify(title);
  const taken = await db
    .select({ slug: academyVideos.slug })
    .from(academyVideos)
    .where(or(eq(academyVideos.slug, base), like(academyVideos.slug, `${base}-%`)));
  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** sort_order that puts a new/moved video at the end of its category. */
export async function nextVideoSortOrder(categoryId: string, excludeId?: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${academyVideos.sortOrder})` })
    .from(academyVideos)
    .where(
      excludeId
        ? and(eq(academyVideos.categoryId, categoryId), sql`${academyVideos.id} <> ${excludeId}`)
        : eq(academyVideos.categoryId, categoryId),
    );
  return (row?.max ?? -1) + 1;
}
