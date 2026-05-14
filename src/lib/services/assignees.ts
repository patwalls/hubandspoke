import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  brands,
  formats,
  productionItems,
  users,
} from "@/lib/db/schema";

const GLOBAL_FALLBACK_EMAIL = "patrickswalls@gmail.com";

let cachedGlobalFallbackUserId: string | null = null;

async function getGlobalFallbackUserId(): Promise<string> {
  if (cachedGlobalFallbackUserId) return cachedGlobalFallbackUserId;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${GLOBAL_FALLBACK_EMAIL.toLowerCase()}`)
    .limit(1);
  if (!row) {
    throw new Error(
      `resolveEditor: global fallback user ${GLOBAL_FALLBACK_EMAIL} not found in users table`
    );
  }
  cachedGlobalFallbackUserId = row.id;
  return row.id;
}

export interface ResolveEditorInput {
  brand: string;
  sourceItemId?: string | null;
  format?: string | null;
}

/**
 * Returns the editor user id for a new production_items row, falling through:
 * source item → format default (by name+brand) → brand default → global
 * fallback (pat). Never returns null — every item gets an owner.
 */
export async function resolveEditor(
  input: ResolveEditorInput
): Promise<string> {
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

  if (!editorUserId) {
    editorUserId = await getGlobalFallbackUserId();
  }

  return editorUserId;
}
