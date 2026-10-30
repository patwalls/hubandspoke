import { NextRequest, NextResponse } from "next/server";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { contentDrafts, productionItems } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth-guards";
import {
  learnedFromEdits,
  loadEditorRewrites,
} from "@/lib/services/draft-algorithm/editor-rewrites";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The editor rewrites this item's AI draft learned from, for the content
 * page's "Learned from N edits" chip (drafts-learn M3). Only answers with
 * examples when one of the item's drafts came from a Draft Algorithm run
 * that read them (prompt v16+) — otherwise the chip would claim learning
 * that never happened. Same query the worker ran, re-read now, so a
 * rewrite saved after this draft can show up; close enough for a peek.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const guard = await requireSession();
  if (guard.response) return guard.response;
  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ format: null, examples: [] });

  const [item] = await db
    .select({ brand: productionItems.brand, format: productionItems.format })
    .from(productionItems)
    .where(eq(productionItems.id, id))
    .limit(1);
  if (!item?.format) return NextResponse.json({ format: null, examples: [] });

  const runs = await db
    .select({ generatedBy: contentDrafts.generatedBy })
    .from(contentDrafts)
    .where(
      and(
        eq(contentDrafts.productionItemId, id),
        like(contentDrafts.generatedBy, "draft-algo%"),
      ),
    );
  if (!runs.some((r) => learnedFromEdits(r.generatedBy))) {
    return NextResponse.json({ format: item.format, examples: [] });
  }

  const examples = await loadEditorRewrites({
    brand: item.brand,
    format: item.format,
    excludeId: id,
  });
  return NextResponse.json({ format: item.format, examples });
}
