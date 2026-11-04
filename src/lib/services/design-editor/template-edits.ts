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
import { and, desc, eq, gte, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { designDocs, productionItems } from "@/lib/db/schema";
import { parseDesignDoc, type DesignDoc } from "@/lib/design-editor/doc";
import { rollUpTemplateEdits, slotRewrites, type DesignEditSample, type SlotPlace, type SlotRewrite, type TemplateEditRow } from "@/lib/design-editor/design-edits";

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

/** Brief values as `{ key, text }` (text slots only), empty when unreadable. */
export function briefValues(brief: unknown): Array<{ key: string; text: string }> {
  const values = (brief as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => v as { key?: unknown; text?: unknown })
    .filter((v): v is { key: string; text: string } => typeof v?.key === "string" && typeof v?.text === "string");
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

// ── Feeding the rewrites back into the next fill (design-edits M4) ──────────

/** Editorial taste drifts; same window as the text drafts' rewrite pairs. */
export const REWRITE_WINDOW_DAYS = 60;
/** Per slot, the newest few pairs are enough to show the pattern … */
export const MAX_REWRITES_PER_SLOT = 3;
/** … and the whole block stays a small part of the fill prompt. */
export const MAX_REWRITES = 12;
const REWRITE_CHARS = 300;

/**
 * The format's recent (AI wrote → editor shipped) pairs per slot, newest
 * first, for fill-brief's prompt: the headline an editor shortens on every
 * post, the stat they always reword. One small read per fill (fills run on
 * the worker, once per draft / Regenerate), so no cache. `places` is the
 * format template's slots (listSlots) — how older briefs, drafted before the
 * kept draft existed, are matched to the final doc's elements.
 */
export async function loadSlotRewrites(args: {
  brand: string;
  formatName: string;
  excludeItemId: string | null;
  places: SlotPlace[];
}): Promise<SlotRewrite[]> {
  if (!args.brand || !args.formatName) return [];
  const since = new Date(Date.now() - REWRITE_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ doc: designDocs.doc, generatedDoc: designDocs.generatedDoc, brief: designDocs.brief })
    .from(designDocs)
    .innerJoin(productionItems, eq(productionItems.id, designDocs.productionItemId))
    .where(
      and(
        eq(productionItems.brand, args.brand),
        eq(productionItems.format, args.formatName),
        isNotNull(designDocs.brief),
        gte(designDocs.updatedAt, since),
        args.excludeItemId ? ne(productionItems.id, args.excludeItemId) : undefined,
      ),
    )
    .orderBy(desc(designDocs.updatedAt))
    .limit(RECENT_DESIGNS);
  const perSlot = new Map<string, number>();
  const out: SlotRewrite[] = [];
  for (const r of rows) {
    const final = docOrNull(r.doc);
    if (!final) continue;
    for (const p of slotRewrites({ final, generated: docOrNull(r.generatedDoc), brief: briefValues(r.brief), places: args.places })) {
      const n = perSlot.get(p.slot) ?? 0;
      if (n >= MAX_REWRITES_PER_SLOT) continue;
      perSlot.set(p.slot, n + 1);
      out.push({ slot: p.slot, ai: p.ai.slice(0, REWRITE_CHARS), edited: p.edited.slice(0, REWRITE_CHARS) });
      if (out.length >= MAX_REWRITES) return out;
    }
  }
  return out;
}
