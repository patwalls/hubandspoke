import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs } from "@/lib/db/schema";
import type { DesignDoc } from "@/lib/design-editor/doc";

export type SaveDesignResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict"; currentRevision: number }
  | { ok: false; reason: "not_found" };

/** Optimistic-concurrency save, exactly like the clip editor's. */
export async function saveDesignDoc(args: {
  productionItemId: string;
  expectedRevision: number;
  doc: DesignDoc;
}): Promise<SaveDesignResult> {
  const [updated] = await db
    .update(designDocs)
    .set({ doc: args.doc, revision: sql`${designDocs.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(designDocs.productionItemId, args.productionItemId), eq(designDocs.revision, args.expectedRevision)))
    .returning({ revision: designDocs.revision });
  if (updated) return { ok: true, revision: updated.revision };
  const [current] = await db
    .select({ revision: designDocs.revision })
    .from(designDocs)
    .where(eq(designDocs.productionItemId, args.productionItemId))
    .limit(1);
  return current ? { ok: false, reason: "conflict", currentRevision: current.revision } : { ok: false, reason: "not_found" };
}
