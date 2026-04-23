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
      `resolveAssignees: global fallback user ${GLOBAL_FALLBACK_EMAIL} not found in users table`
    );
  }
  cachedGlobalFallbackUserId = row.id;
  return row.id;
}

export interface ResolveAssigneesInput {
  brand: string;
  sourceItemId?: string | null;
  format?: string | null;
}

export interface ResolvedAssignees {
  producerUserId: string;
  editorUserId: string;
}

/**
 * Returns non-null producer/editor user ids for a new production_items row,
 * falling back through: source item → format defaults (by name+brand) →
 * brand_settings defaults → global fallback (pat).
 *
 * Producer and editor resolve independently — a source item with a set
 * producer but null editor will keep the producer and fall through for editor.
 */
export async function resolveAssignees(
  input: ResolveAssigneesInput
): Promise<ResolvedAssignees> {
  let producerUserId: string | null = null;
  let editorUserId: string | null = null;

  if (input.sourceItemId) {
    const [src] = await db
      .select({
        producerUserId: productionItems.producerUserId,
        editorUserId: productionItems.editorUserId,
      })
      .from(productionItems)
      .where(eq(productionItems.id, input.sourceItemId))
      .limit(1);
    if (src) {
      producerUserId = src.producerUserId ?? null;
      editorUserId = src.editorUserId ?? null;
    }
  }

  if ((!producerUserId || !editorUserId) && input.format) {
    const [fmt] = await db
      .select({
        producerNotionUserId: formats.producerNotionUserId,
        editorNotionUserId: formats.editorNotionUserId,
      })
      .from(formats)
      .where(
        and(eq(formats.name, input.format), eq(formats.brand, input.brand))
      )
      .limit(1);

    if (fmt) {
      if (!producerUserId && fmt.producerNotionUserId) {
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.notionUserId, fmt.producerNotionUserId))
          .limit(1);
        if (u) producerUserId = u.id;
      }
      if (!editorUserId && fmt.editorNotionUserId) {
        const [u] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.notionUserId, fmt.editorNotionUserId))
          .limit(1);
        if (u) editorUserId = u.id;
      }
    }
  }

  if (!producerUserId || !editorUserId) {
    const [bs] = await db
      .select({
        defaultProducerUserId: brands.defaultProducerUserId,
        defaultEditorUserId: brands.defaultEditorUserId,
      })
      .from(brands)
      .where(eq(brands.slug, input.brand))
      .limit(1);
    if (bs) {
      if (!producerUserId) producerUserId = bs.defaultProducerUserId ?? null;
      if (!editorUserId) editorUserId = bs.defaultEditorUserId ?? null;
    }
  }

  if (!producerUserId || !editorUserId) {
    const fallback = await getGlobalFallbackUserId();
    producerUserId = producerUserId ?? fallback;
    editorUserId = editorUserId ?? fallback;
  }

  return { producerUserId, editorUserId };
}
