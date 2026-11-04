/**
 * What editors change in a format's AI-drafted designs (design-edits M2): the
 * format page's "Editors change" line under the design template.
 *
 * Reads the format's most recent designs (design_docs of its posts) and rolls
 * them up per AI-filled element with `rollUpTemplateEdits` — words from the
 * brief (every draft), look from the kept draft (`generated_doc`, drafts
 * since 2026-11-03). Cross-post forks are copies of an already-edited design,
 * not drafts, so only docs with a brief are read. Read on page open; the
 * query is one indexed join capped at RECENT rows, so no cache.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs, productionItems } from "@/lib/db/schema";
import { parseDesignDoc, type DesignDoc } from "@/lib/design-editor/doc";
import { rollUpTemplateEdits, type DesignEditSample, type TemplateEditRow } from "@/lib/design-editor/design-edits";

/** How many recent designs a format page reads. */
export const RECENT_DESIGNS = 30;
/** Below this many designs a share ("1 of 2") says nothing: show nothing. */
export const MIN_DESIGNS = 3;

export interface TemplateEdits {
  posts: number;
  rows: TemplateEditRow[];
}

/** Brief values' texts (`{ values: [{ key, text }] }`), empty when unreadable. */
export function briefTexts(brief: unknown): string[] {
  const values = (brief as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) return [];
  return values.map((v) => (v as { text?: unknown })?.text).filter((t): t is string => typeof t === "string");
}

const docOrNull = (raw: unknown): DesignDoc | null => {
  if (!raw) return null;
  const parsed = parseDesignDoc(raw);
  return parsed.ok ? parsed.doc : null;
};

export async function loadTemplateEdits(brand: string, formatName: string): Promise<TemplateEdits | null> {
  const rows = await db
    .select({ doc: designDocs.doc, generatedDoc: designDocs.generatedDoc, brief: designDocs.brief })
    .from(designDocs)
    .innerJoin(productionItems, eq(productionItems.id, designDocs.productionItemId))
    .where(and(eq(productionItems.brand, brand), eq(productionItems.format, formatName), isNotNull(designDocs.brief)))
    .orderBy(desc(designDocs.createdAt))
    .limit(RECENT_DESIGNS);
  const samples: DesignEditSample[] = [];
  for (const r of rows) {
    const final = docOrNull(r.doc);
    if (!final) continue;
    samples.push({ final, generated: docOrNull(r.generatedDoc), briefTexts: briefTexts(r.brief) });
  }
  if (samples.length < MIN_DESIGNS) return null;
  const out = rollUpTemplateEdits(samples);
  return out.length ? { posts: samples.length, rows: out } : null;
}
