import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brands,
  formats,
  productionItems,
  users,
} from "@/lib/db/schema";

export interface ResolveEditorInput {
  brand: string;
  sourceItemId?: string | null;
  format?: string | null;
}

/**
 * Returns the editor user id for a new production_items row, falling through:
 * source item → format default (by name+brand) → brand default. Null when
 * none of them has an owner: the item starts unassigned. (Until 2026-10-23
 * the last step was "Pat", which handed him every ownerless item.)
 */
export async function resolveEditor(
  input: ResolveEditorInput
): Promise<string | null> {
  let editorUserId: string | null = null;

  if (input.sourceItemId) {
    const [src] = await db
      .select({ editorUserId: productionItems.editorUserId })
      .from(productionItems)
      .where(eq(productionItems.id, input.sourceItemId))
      .limit(1);
    if (src) editorUserId = src.editorUserId ?? null;
  }

  if (!editorUserId && input.format) {
    const [fmt] = await db
      .select({ editorNotionUserId: formats.editorNotionUserId })
      .from(formats)
      .where(
        and(eq(formats.name, input.format), eq(formats.brand, input.brand))
      )
      .limit(1);

    if (fmt?.editorNotionUserId) {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.notionUserId, fmt.editorNotionUserId))
        .limit(1);
      if (u) editorUserId = u.id;
    }
  }

  if (!editorUserId) {
    const [bs] = await db
      .select({ defaultEditorUserId: brands.defaultEditorUserId })
      .from(brands)
      .where(eq(brands.slug, input.brand))
      .limit(1);
    if (bs?.defaultEditorUserId) editorUserId = bs.defaultEditorUserId;
  }

  return editorUserId;
}
