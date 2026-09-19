/**
 * A format's design template: the stored one (`formats.design_template`,
 * edited on the format page), else the built-in preset for the format, else
 * nothing (the format keeps the classic dialog).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { formats } from "@/lib/db/schema";
import { parseDesignDoc, type DesignDoc } from "@/lib/design-editor/doc";
import { DEFAULT_PRESET_FOR_FORMAT, DESIGN_PRESETS, type DesignPresetId } from "@/lib/design-editor/templates";

export interface FormatTemplate {
  doc: DesignDoc;
  source: "stored" | "preset";
  formatId: string;
  updatedAt: Date | null;
}

export async function loadFormatTemplate(brand: string, formatName: string): Promise<FormatTemplate | null> {
  const [row] = await db
    .select({ id: formats.id, doc: formats.designTemplate, updatedAt: formats.designTemplateUpdatedAt })
    .from(formats)
    .where(and(eq(formats.brand, brand), eq(formats.name, formatName)))
    .limit(1);
  if (!row) return null;
  return templateFor({ id: row.id, name: formatName, doc: row.doc, updatedAt: row.updatedAt });
}

export async function loadFormatTemplateById(formatId: string): Promise<(FormatTemplate & { name: string; brand: string }) | null> {
  const [row] = await db
    .select({ id: formats.id, name: formats.name, brand: formats.brand, doc: formats.designTemplate, updatedAt: formats.designTemplateUpdatedAt })
    .from(formats)
    .where(eq(formats.id, formatId))
    .limit(1);
  if (!row) return null;
  const t = templateFor(row);
  return t ? { ...t, name: row.name, brand: row.brand } : null;
}

function templateFor(row: { id: string; name: string; doc: unknown; updatedAt: Date | null }): FormatTemplate | null {
  if (row.doc) {
    const parsed = parseDesignDoc(row.doc);
    if (parsed.ok) return { doc: parsed.doc, source: "stored", formatId: row.id, updatedAt: row.updatedAt };
    console.warn(`[design-editor] stored template for format ${row.id} is invalid: ${parsed.error}`);
  }
  const preset = DEFAULT_PRESET_FOR_FORMAT[row.name];
  if (!preset) return null;
  return { doc: DESIGN_PRESETS[preset].build(), source: "preset", formatId: row.id, updatedAt: null };
}

/** Format names (for a brand) the design editor can draft — for the queue
 *  dialogs, which decide client-side which UI to open. */
export async function formatsWithDesignTemplate(brand: string): Promise<string[]> {
  const rows = await db.select({ name: formats.name, doc: formats.designTemplate }).from(formats).where(eq(formats.brand, brand));
  return rows.filter((r) => !!r.doc || r.name in DEFAULT_PRESET_FOR_FORMAT).map((r) => r.name);
}

export async function saveFormatTemplate(formatId: string, doc: DesignDoc): Promise<void> {
  await db.update(formats).set({ designTemplate: doc, designTemplateUpdatedAt: new Date() }).where(eq(formats.id, formatId));
}

export async function createFormatTemplateFromPreset(formatId: string, preset: DesignPresetId): Promise<DesignDoc> {
  const doc = DESIGN_PRESETS[preset].build();
  await saveFormatTemplate(formatId, doc);
  return doc;
}

export async function clearFormatTemplate(formatId: string): Promise<void> {
  await db.update(formats).set({ designTemplate: null, designTemplateUpdatedAt: null }).where(and(eq(formats.id, formatId), isNotNull(formats.designTemplate)));
}
